/**
 * 聊天内置命令（'/' 前缀，先于 agent 处理）。
 *
 * 权限：adminOnly 命令仅管理员可用；/reset 在"每群共享"模式下仅
 * 管理员可用（重置影响全群），perUser 模式下人人可重置自己的会话。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { DshQQConfig } from '../config.ts';
import type { ChatBridgeManager } from '../bridge/chat.ts';
import { defaultAgentCwd, isSameDir } from '../bridge/chat.ts';
import { describeModelSource, formatModelSpec, parseModelSpec } from '../bridge/modelRoutes.ts';
import type { OneBotApi } from '../onebot/api.ts';
import type { AdminStore } from '../pipeline/access.ts';
import type { PersonaStore } from '../persona/store.ts';
import type { DshServices } from '../dsh.ts';
import { providerId } from '../dsh.ts';
import type { InboundMessage } from '../onebot/events.ts';
import { tokenUsage } from '../bridge/agentRunner.ts';
import type { MessageLogService } from '../logs/store.ts';
import { formatLogDigest } from '../logs/format.ts';
import { describeSchedule, nextRunForTask } from '../tasks/schedule.ts';
import type { ScheduledTask, TaskStore } from '../tasks/store.ts';
import type { MemoryLike } from '../memory/index.ts';

export interface CommandContext {
	msg: InboundMessage;
	/** 命令后的参数（已去空白）。 */
	arg: string;
	bridge: ReturnType<ChatBridgeManager['bridgeFor']>;
	manager: ChatBridgeManager;
	api: OneBotApi;
	config: DshQQConfig;
	admins: AdminStore;
	store: PersonaStore;
	services: DshServices;
	/** 消息日志服务（/logs 用；缺失时命令提示不可用）。 */
	logs?: MessageLogService;
	/** 定时任务库（/tasks 用）。 */
	tasks: TaskStore;
	/** 立即触发一个定时任务（/tasks run 用；走与调度器相同的会话桥管线）。 */
	runTask(task: ScheduledTask): void;
	/** 长期记忆服务（/memory 用；未启用时为 ready=false 的实现）。 */
	memory?: MemoryLike;
	reply(text: string): Promise<void>;
}

export interface CommandDef {
	adminOnly?: boolean;
	usage: string;
	help: string;
	run(ctx: CommandContext): Promise<void>;
}

/** 当前会话是否允许普通成员 /reset。 */
function canReset(ctx: CommandContext): boolean {
	if (ctx.msg.chatType === 'private') return true;
	if (ctx.config.groupSession === 'perUser') return true;
	return ctx.admins.isAdmin(ctx.msg.senderId);
}

/** 当前会话是否允许普通成员增删定时任务（共享群会话影响全群，仅管理员）。 */
function canManageTasks(ctx: CommandContext): boolean {
	return canReset(ctx);
}

/** 解析 /cwd 参数为目标目录：`~` 展开为主目录，其余按绝对路径解析。 */
export function resolveCwdArg(arg: string, homeDir: string): string {
	if (arg === '~' || arg === '~/') return homeDir;
	if (arg.startsWith('~/')) return join(homeDir, arg.slice(2));
	return resolve(arg);
}

/** 校验目标目录存在且为目录；返回错误消息或 null。 */
export function validateCwdDir(path: string): string | null {
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return `目录不存在：${path}`;
	}
	if (!stat.isDirectory()) return `不是目录：${path}`;
	return null;
}

export const COMMANDS: Record<string, CommandDef> = {
	help: {
		usage: '/help',
		help: '查看可用命令',
		async run(ctx) {
			const lines = ['dsh-qq-bot 指令：', ''];
			for (const def of Object.values(COMMANDS)) {
				if (def.adminOnly && !ctx.admins.isAdmin(ctx.msg.senderId)) continue;
				lines.push(`${def.usage} — ${def.help}`);
			}
			await ctx.reply(lines.join('\n'));
		},
	},
	status: {
		usage: '/status',
		help: '连接与会话状态',
		async run(ctx) {
			// 只读诊断：句柄被界面占着时不等待（等几分钟才回一句状态没有意义），
			// 直接在下面报出占用情况。
			const agent = await ctx.bridge.ensureAgent({ waitOnBusy: false }).catch(() => undefined);
			const info = ctx.bridge.modelInfo();
			const usage = agent !== undefined ? tokenUsage(agent) : { input: 0, output: 0 };
			// 会话 cwd 创建后不可变：resume 回来的会话可能停在旧目录（改过配置/
			// 换过工作区/标记文件丢过），这时 agentCwd 只是"本次配置期望值"，
			// 必须把 header 里的真实值也报出来，否则用户无从判断分组为何不生效。
			const actualCwd = ctx.bridge.sessionCwd();
			const cwdLine = actualCwd !== undefined && !isSameDir(actualCwd, ctx.bridge.agentCwd)
				? `工作目录：${actualCwd}（配置为 ${ctx.bridge.agentCwd}；dsh 会话目录不可修改，/reset 后生效）`
				: `工作目录：${ctx.bridge.agentCwd}${ctx.bridge.agentCwd === ctx.bridge.sessionDir ? '' : `（默认目录 ${ctx.bridge.sessionDir}）`}`;
			const lines = [
				`连接：${ctx.api.connected ? '已连接' : '未连接（自动重连中）'}`,
				`活跃会话：${ctx.manager.size}`,
				`会话 id：${ctx.bridge.sessionIdString}`,
				`写句柄：${ctx.bridge.dispositionText()}`,
				...(ctx.bridge.hasPendingQuestion() ? ['提问：agent 正在等本会话的回答（问题已发到 QQ，直接回复即算答案）'] : []),
				`模型：${info.spec === '' ? '部署默认' : info.spec}（${describeModelSource(info.source)}）`,
				`Token 累计：输入 ${usage.input} / 输出 ${usage.output}`,
				cwdLine,
			];
			await ctx.reply(lines.join('\n'));
		},
	},
	reclaim: {
		usage: '/reclaim',
		help: '会话被界面占用时立刻重试接管（管理员）',
		adminOnly: true,
		async run(ctx) {
			// 只发信号，不做任何阻塞动作：真正卡在等待里的那一轮会立刻重试一次
			// （见 ChatBridge.requestReclaim）。能否成功取决于界面是否已释放句柄——
			// 插件不接管宿主已有的 agent（那会绕过工具权限守卫与人格/模型 setup）。
			ctx.bridge.requestReclaim();
			const disposition = ctx.bridge.disposition();
			if (disposition === 'ours') {
				await ctx.reply('✅ 写句柄在本插件手里，无需接管。');
				return;
			}
			if (disposition === 'none') {
				await ctx.reply('ℹ️ 当前没有活动写句柄：下一条消息会建立会话（若先被 dsh 界面打开，就会由界面持有）。');
				return;
			}
			await ctx.reply(
				[
					'⏳ 已请求立刻重试接管，但写句柄仍被 dsh 界面持有。',
					'请先关掉那边打开的**这个**会话（只关标签页不一定立刻释放，必要时重启 dsh web），然后重发消息即可原地继续。',
					'不想等的话，发 /reset 会直接开一个全新会话（旧历史保留，但上下文清零）。',
				].join('\n'),
			);
		},
	},
	reset: {
		usage: '/reset',
		help: '清空当前会话上下文，开启新对话',
		async run(ctx) {
			if (!canReset(ctx)) {
				await ctx.reply('❌ 共享群会话的 /reset 仅管理员可用（私聊和独立会话不受限）');
				return;
			}
			await ctx.bridge.reset();
			await ctx.reply('✅ 已重置会话，开始新对话');
		},
	},
	memory: {
		usage: '/memory [distill|reload]',
		help: '查看本会话的长期记忆（卡片条目与档案规模）；distill = 立即蒸馏这一段对话，reload = 解冻卡片缓存',
		async run(ctx) {
			const memory = ctx.memory;
			if (memory === undefined || !memory.ready) {
				await ctx.reply('（长期记忆未启用或存储不可用；在 WebUI「设置 → qq-bot 配置 → 长期记忆」里打开，或检查日志里的诊断）');
				return;
			}
			const sub = ctx.arg.trim().toLowerCase();
			if (sub === 'distill') {
				await ctx.reply('⏳ 正在蒸馏这一段对话…');
				const changed = await memory.distill(ctx.bridge.key, { force: true });
				if (changed) {
					await ctx.reply('✅ 长期记忆已更新（卡片会在下一段会话开始时生效）');
					return;
				}
				// 失败原因直接回给用户：dsh 自己的 logger 在部分部署里不落盘，
				// 只丢一句"详见日志"等于让人无从下手。
				const reason = memory.lastDistillError?.(ctx.bridge.key);
				await ctx.reply(reason === undefined ? '（没有可蒸馏的新内容）' : `⚠️ 蒸馏失败：${reason}`);
				return;
			}
			if (sub === 'reload') {
				memory.unfreeze(ctx.bridge.key);
				await ctx.reply('✅ 已解冻记忆卡片（本轮起系统提示读到最新条目）');
				return;
			}
			const card = memory.cardSection(ctx.bridge.key);
			const chat = memory.chatStats(ctx.bridge.key);
			const stats = memory.stats();
			const lines = [
				`【长期记忆】${ctx.bridge.label}`,
				`卡片：${chat.facts} 条事实；档案：${chat.events} 条消息（全库 ${stats.facts} 条事实 / ${stats.events} 条消息 / ${stats.chats} 个会话）`,
				card === '' ? '（本会话还没有记忆条目）' : card,
				'',
				'用法：/memory distill 立即蒸馏 ｜ /memory reload 解冻卡片 ｜ agent 可用 qq_memorize / qq_recall_memory（默认仅管理员）',
			];
			await ctx.reply(lines.join('\n'));
		},
	},
	new: {
		usage: '/new',
		help: '同 /reset，开启新对话',
		async run(ctx) {
			await COMMANDS.reset!.run(ctx);
		},
	},
	stop: {
		usage: '/stop',
		help: '停止当前会话正在进行的任务（不清历史）',
		async run(ctx) {
			const agent = await ctx.bridge.ensureAgent().catch(() => undefined);
			if (agent === undefined) {
				await ctx.reply('当前没有活动会话');
				return;
			}
			if (agent.status !== 'running') {
				await ctx.reply('✅ 当前没有正在运行的任务');
				return;
			}
			agent.cancel({ kind: 'user' });
			await ctx.reply('✅ 已请求停止当前任务');
		},
	},
	sid: {
		usage: '/sid',
		help: '查看当前会话标识',
		async run(ctx) {
			await ctx.reply(`chatKey：${ctx.bridge.key}\nsessionId：${ctx.bridge.sessionIdString}`);
		},
	},
	model: {
		usage: '/model [provider/model|clear]',
		help: '查看/切换当前会话的模型（会话覆盖优先于配置路由）',
		async run(ctx) {
			const arg = ctx.arg.trim();
			const info = ctx.bridge.modelInfo();
			const current = info.spec === '' ? '部署默认' : info.spec;
			if (arg === '') {
				const llm = ctx.services.llm;
				const lines = [`当前模型：${current}（来源：${describeModelSource(info.source)}）`];
				const override = ctx.store.getChatModel(ctx.bridge.key);
				if (override !== undefined && override !== '') lines.push(`本会话覆盖：${override}（/model clear 清除）`);
				if (llm !== undefined) {
					try {
						for (const entry of llm.listProviders()) {
							const provider = providerId(entry);
							const models = await llm.listModels(provider);
							const names = models.map((m) => `${provider}/${m.id}`).join('  ');
							if (names !== '') lines.push(names);
						}
					} catch {
						lines.push('（模型列表拉取失败，可直接 /model provider/model 设置）');
					}
				} else {
					lines.push('（llm 服务不可用，可直接 /model provider/model 设置）');
				}
				lines.push('用法：/model deepseek/deepseek-chat 或 /model clear');
				await ctx.reply(lines.join('\n'));
				return;
			}
			if (arg === 'clear') {
				ctx.store.setChatModel(ctx.bridge.key, null);
				await ctx.bridge.rebuild();
				const next = ctx.bridge.modelInfo();
				await ctx.reply(`✅ 已清除本会话模型覆盖，恢复为 ${next.spec === '' ? '部署默认' : next.spec}（${describeModelSource(next.source)}）`);
				return;
			}
			const route = parseModelSpec(arg);
			if (route === null) {
				await ctx.reply('❌ 模型格式不对，应为 provider/model 或 model');
				return;
			}
			const spec = formatModelSpec(route);
			ctx.store.setChatModel(ctx.bridge.key, spec);
			await ctx.bridge.rebuild();
			await ctx.reply(`✅ 已切换模型 ${spec}（仅本会话生效，历史保留；/model clear 恢复配置路由）`);
		},
	},
	persona: {
		usage: '/persona [名称|default]',
		help: '查看/切换当前会话人格',
		async run(ctx) {
			const arg = ctx.arg.trim();
			if (arg === '') {
				const current = ctx.store.resolve(ctx.bridge.key);
				const names = ctx.store.list();
				await ctx.reply([`当前人格：${current.name}`, `可用：${names.join('、')}`, '用法：/persona 名称（default 清除覆盖）'].join('\n'));
				return;
			}
			const name = arg === 'default' ? null : arg;
			if (name !== null && !ctx.store.list().includes(name)) {
				await ctx.reply(`❌ 没有人格 "${name}"，可用：${ctx.store.list().join('、') || '（无）'}`);
				return;
			}
			ctx.store.setChatPersona(ctx.bridge.key, name);
			await ctx.bridge.rebuild();
			await ctx.reply(name === null ? '✅ 已恢复默认人格' : `✅ 已切换人格 ${name}（历史保留）`);
		},
	},
	cwd: {
		adminOnly: true,
		usage: '/cwd [路径|~|reset]',
		help: '查看/切换会话工作目录（~ = 网关模式；reset = 还原默认）',
		async run(ctx) {
			const bridge = ctx.bridge;
			const arg = ctx.arg.trim();
			if (arg === '') {
				await ctx.reply(
					[
						`当前工作目录：${bridge.agentCwd}`,
						`默认目录：${bridge.sessionDir}`,
						'用法：/cwd <目录>（切到项目目录）| /cwd ~（网关模式，可操作整台电脑）| /cwd reset（还原默认）',
						'切换会开启新会话，历史上下文清空。',
					].join('\n'),
				);
				return;
			}
			let target: string | null;
			if (arg === 'reset') {
				target = null;
			} else {
				const dir = resolveCwdArg(arg, homedir());
				const invalid = validateCwdDir(dir);
				if (invalid !== null) {
					await ctx.reply(invalid);
					return;
				}
				target = dir;
			}
			await ctx.manager.switchWorkspace(bridge.key, target);
			const nextCwd = target ?? defaultAgentCwd({ workspaceMode: ctx.config.workspaceMode, homeDir: homedir(), sessionDir: bridge.sessionDir });
			const suffix = target === null ? '' : nextCwd === homedir() ? '（网关模式：agent 可操作整台电脑）' : '';
			await ctx.reply(`✅ 工作目录已切换为 ${nextCwd}${suffix}，新会话开始（历史清空）`);
		},
	},
	op: {
		adminOnly: true,
		usage: '/op <QQ号>',
		help: '添加管理员（持久化）',
		async run(ctx) {
			const qq = ctx.arg.trim();
			if (!/^\d{5,11}$/.test(qq)) {
				await ctx.reply('用法：/op <QQ号>');
				return;
			}
			const added = await ctx.admins.add(qq);
			await ctx.reply(added ? `✅ 已添加管理员 ${qq}` : `${qq} 已经是管理员了`);
		},
	},
	deop: {
		adminOnly: true,
		usage: '/deop <QQ号>',
		help: '移除动态添加的管理员',
		async run(ctx) {
			const qq = ctx.arg.trim();
			const removed = await ctx.admins.remove(qq);
			await ctx.reply(removed ? `✅ 已移除管理员 ${qq}` : `${qq} 不在动态管理员里（配置文件里写死的要改配置才能移除）`);
		},
	},
	logs: {
		adminOnly: true,
		usage: '/logs [条数]',
		help: '查看最近的消息日志（OneBot 收发与 dsh 回复，默认 10 条，上限 30）',
		async run(ctx) {
			const logs = ctx.logs;
			if (logs === undefined) {
				await ctx.reply('（消息日志未启用）');
				return;
			}
			if (ctx.arg.trim() === 'clear') {
				logs.clear();
				await ctx.reply('✅ 已清空消息日志（仅内存缓冲，不影响落盘文件）');
				return;
			}
			const parsed = Number.parseInt(ctx.arg.trim(), 10);
			const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 30) : 10;
			await ctx.reply(formatLogDigest(logs.recent({ limit }), logs.size));
		},
	},
	tasks: {
		usage: '/tasks [del|run|on|off <id前缀>] | clear',
		help: '查看/管理本会话的定时任务（到期机器人主动发消息；说"每天9点叫我起床"即可由 agent 代建）',
		async run(ctx) {
			const all = ctx.tasks.listByChat(ctx.bridge.key);
			const body = ctx.arg.trim();
			const space = body.search(/\s/);
			const sub = (space < 0 ? body : body.slice(0, space)).toLowerCase();
			const idArg = space < 0 ? '' : body.slice(space).trim();

			/** 本地时间 MM-DD HH:mm（/tasks 展示用）。 */
			const clock = (ms: number): string => {
				const date = new Date(ms);
				const pad = (value: number) => String(value).padStart(2, '0');
				return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
			};
			const describe = (task: ScheduledTask): string => {
				const next = nextRunForTask(task);
				return [
					`[${task.id}] ${describeSchedule(task.schedule)}`,
					task.enabled ? (next !== null ? `下次 ${clock(next)}` : '（已到期）') : '已停用',
					task.note !== undefined ? ` · ${task.note}` : '',
				].join(' ');
			};

			if (sub === '') {
				if (all.length === 0) {
					await ctx.reply('本会话还没有定时任务。直接说"每天9点叫我起床"，或用 /tasks 管理已有任务。');
					return;
				}
				await ctx.reply([`本会话定时任务（${all.length}）：`, ...all.map((task, index) => `${index + 1}. ${describe(task)}`)].join('\n'));
				return;
			}
			if (sub === 'clear') {
				if (!canManageTasks(ctx)) {
					await ctx.reply('❌ 共享群会话的定时任务管理仅管理员可用（私聊和独立会话不受限）');
					return;
				}
				for (const task of all) ctx.tasks.remove(task.id);
				await ctx.reply(`✅ 已清空本会话的 ${all.length} 个定时任务`);
				return;
			}
			if (sub === 'del' || sub === 'rm' || sub === 'off' || sub === 'on' || sub === 'run') {
				if (!canManageTasks(ctx)) {
					await ctx.reply('❌ 共享群会话的定时任务管理仅管理员可用（私聊和独立会话不受限）');
					return;
				}
				if (idArg === '') {
					await ctx.reply(`用法：/tasks ${sub} <id前缀>（/tasks 查看任务 id）`);
					return;
				}
				const matches = all.filter((task) => task.id.startsWith(idArg));
				if (matches.length > 1) {
					await ctx.reply(`❌ id 前缀匹配到 ${matches.length} 个任务，请给更长的前缀`);
					return;
				}
				const task = matches[0];
				if (task === undefined) {
					await ctx.reply(`❌ 没有找到任务 "${idArg}"（/tasks 查看任务 id）`);
					return;
				}
				if (sub === 'del' || sub === 'rm') {
					ctx.tasks.remove(task.id);
					await ctx.reply(`✅ 已删除定时任务 ${task.id}（${describeSchedule(task.schedule)}）`);
					return;
				}
				if (sub === 'on' || sub === 'off') {
					ctx.tasks.setEnabled(task.id, sub === 'on');
					await ctx.reply(`✅ 已${sub === 'on' ? '启用' : '停用'}定时任务 ${task.id}（${describeSchedule(task.schedule)}）`);
					return;
				}
				ctx.runTask(task);
				await ctx.reply(`⏳ 已手动触发任务 ${task.id}，结果稍后发到本会话`);
				return;
			}
			await ctx.reply('用法：/tasks 查看 ｜ /tasks del|on|off|run <id前缀> ｜ /tasks clear（清空本会话任务）');
		},
	},
	ping: {
		usage: '/ping',
		help: '连通性测试',
		async run(ctx) {
			await ctx.reply('pong');
		},
	},
};

/** 解析命令；返回 null 表示不是命令。 */
export function parseCommand(text: string): { name: string; arg: string } | null {
	if (!text.startsWith('/')) return null;
	const body = text.slice(1).trim();
	if (body === '') return null;
	const space = body.search(/\s/);
	const name = space < 0 ? body : body.slice(0, space);
	const arg = space < 0 ? '' : body.slice(space).trim();
	return { name: name.toLowerCase(), arg };
}
