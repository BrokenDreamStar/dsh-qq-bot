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
import { normalizeBusyStrategy } from '../bridge/reclaim.ts';
import { describeModelSource, formatModelSpec, parseModelSpec } from '../bridge/modelRoutes.ts';
import type { OneBotApi } from '../onebot/api.ts';
import type { AdminStore } from '../pipeline/access.ts';
import type { PersonaStore } from '../persona/store.ts';
import { inspectSoul, MAX_SOUL_CHARS, writeSoulText } from '../persona/soul.ts';
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
		help: '会话被界面占用时重试接管（仅 wait 策略；管理员）',
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
			const strategy = normalizeBusyStrategy(ctx.config.busyStrategy);
			if (strategy === 'fork') {
				await ctx.reply(
					[
						'ℹ️ 当前策略是 fork：下一条消息会直接从原会话分叉（完整保留上下文），不需要 /reclaim。',
						'想等界面关掉后原地继续，把「会话被界面占用时」改成 wait；想直接开全新会话，改成 rotate。',
					].join('\n'),
				);
				return;
			}
			if (strategy === 'rotate') {
				await ctx.reply('ℹ️ 当前策略是 rotate：下一条消息会直接开新会话（旧历史保留，上下文清零），不需要 /reclaim。');
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
		usage: '/memory [list|search <词>|member [昵称]|forget <id|昵称>|distill|reload]',
		help: '查看本会话的长期记忆：list 列条目，search 检索，member 看群成员画像（管理员），forget 删除条目/成员画像（管理员），distill 立即蒸馏，reload 清缓存',
		async run(ctx) {
			const memory = ctx.memory;
			if (memory === undefined || !memory.ready) {
				await ctx.reply('（长期记忆未启用或存储不可用；在 WebUI「设置 → qq-bot 配置 → 长期记忆」里打开，或检查日志里的诊断）');
				return;
			}
			const [sub = '', ...rest] = ctx.arg.trim().split(/\s+/);
			const tail = rest.join(' ').trim();
			// 普通成员只能看到群级记忆；成员画像属于管理员视图（命令回复会发在群里）。
			const isAdmin = (): boolean => {
				try {
					return ctx.admins.isAdmin(ctx.msg.senderId);
				} catch {
					return true;
				}
			};
			if (sub === 'list') {
				const items = memory.listItems(ctx.bridge.key, { limit: 20, ...(isAdmin() ? {} : { subjectId: null }) });
				if (items.length === 0) {
					await ctx.reply('（本会话还没有记忆条目；说「记住…」或发 /memory distill）');
					return;
				}
				const lines = [`【记忆条目】${ctx.bridge.label}（最近 ${items.length} 条）`];
				for (const item of items) {
					const owner = item.subjectName !== undefined && item.subjectName !== '' ? `@${item.subjectName} ` : '';
					lines.push(`#${item.id} [${item.kind ?? 'fact'}] ${owner}${(item.content ?? item.object).slice(0, 120)}${item.pinned ? ' 📌' : ''}`);
				}
				await ctx.reply(lines.join('\n'));
				return;
			}
			if (sub === 'search') {
				if (tail === '') {
					await ctx.reply('用法：/memory search <关键词>');
					return;
				}
				const result = memory.recall(ctx.bridge.key, tail, 8, undefined, { groupOnly: !isAdmin() });
				await ctx.reply(result.text);
				return;
			}
			if (sub === 'forget') {
				if (!ctx.admins.isAdmin(ctx.msg.senderId)) {
					await ctx.reply('❌ 只有管理员可以删除记忆条目');
					return;
				}
				if (tail === '') {
					await ctx.reply('用法：/memory forget <id> 或 /memory forget <成员昵称>（删掉该成员的全部画像）');
					return;
				}
				const id = Number.parseInt(tail, 10);
				if (Number.isInteger(id) && id > 0) {
					const removed = memory.deleteItem(ctx.bridge.key, id, `admin:${ctx.msg.senderId}`);
					await ctx.reply(removed ? `✅ 已删除记忆 #${id}` : `没有找到 #${id}`);
					return;
				}
				const resolved = memory.resolveMember?.(ctx.bridge.key, tail);
				if (resolved === undefined) {
					await ctx.reply('当前版本不支持成员画像');
					return;
				}
				if (!resolved.ok) {
					await ctx.reply(`❌ ${resolved.error}`);
					return;
				}
				const removed = memory.forgetMember?.(ctx.bridge.key, resolved.member.memberId, `admin:${ctx.msg.senderId}`) ?? 0;
				await ctx.reply(`✅ 已删除「${resolved.member.displayName}」的 ${removed} 条画像`);
				return;
			}
			if (sub === 'member') {
				if (!ctx.admins.isAdmin(ctx.msg.senderId)) {
					await ctx.reply('❌ 群成员画像仅管理员可查看（内容会发在群里，避免暴露他人画像）');
					return;
				}
				const members = memory.listMembers?.(ctx.bridge.key) ?? [];
				if (members.length === 0) {
					await ctx.reply('（本群还没有成员画像；群里有人发言并开启长期记忆后会自动建立）');
					return;
				}
				if (tail === '') {
					const lines = [`【群成员画像】${ctx.bridge.label}（${members.length} 人）`];
					for (const member of members) {
						lines.push(`${member.displayName}：${member.active} 条生效 / ${member.pending} 条待确认`);
					}
					lines.push('', '用法：/memory member <昵称> 查看单个成员；/memory forget <昵称> 删除其画像（管理员）');
					await ctx.reply(lines.join('\n'));
					return;
				}
				const resolved = memory.resolveMember?.(ctx.bridge.key, tail);
				if (resolved === undefined) {
					await ctx.reply('当前版本不支持成员画像');
					return;
				}
				if (!resolved.ok) {
					await ctx.reply(`❌ ${resolved.error}`);
					return;
				}
				const profile = memory.memberProfile?.(ctx.bridge.key, resolved.member.memberId) ?? '';
				const facts = memory.listItems(ctx.bridge.key, { subjectId: resolved.member.memberId, status: 'all', limit: 30 });
				const pending = facts.filter((fact) => fact.status === 'pending').length;
				const lines = [`【成员画像】${resolved.member.displayName}（${facts.length} 条，${pending} 条待确认）`, profile === '' ? '（还没有生效的画像）' : profile];
				if (pending > 0) lines.push(`（有 ${pending} 条待管理员在 WebUI 确认）`);
				await ctx.reply(lines.join('\n'));
				return;
			}
			if (sub === 'distill') {
				await ctx.reply('⏳ 正在蒸馏这一段对话…');
				const changed = await memory.distill(ctx.bridge.key, { force: true });
				if (changed) {
					await ctx.reply('✅ 长期记忆已更新（本轮起生效，画像段下一轮就能看到）');
					return;
				}
				const reason = memory.lastDistillError?.(ctx.bridge.key);
				if (reason !== undefined) {
					await ctx.reply(`⚠️ 蒸馏失败：${reason}`);
					return;
				}
				const note = memory.lastDistillNote?.(ctx.bridge.key);
				await ctx.reply(note === undefined ? '（没有可蒸馏的新内容）' : `ℹ️ ${note}`);
				return;
			}
			if (sub === 'reload') {
				memory.unfreeze(ctx.bridge.key);
				await ctx.reply('✅ 已清画像缓存（本轮起系统提示读到最新条目）');
				return;
			}
			const profile = memory.cardSection(ctx.bridge.key);
			const chat = memory.chatStats(ctx.bridge.key);
			const stats = memory.stats();
			const memberCount = memory.listMembers?.(ctx.bridge.key).length ?? 0;
			const lines = [
				`【长期记忆】${ctx.bridge.label}`,
				`记忆：${chat.facts} 条条目（含成员画像）；档案：${chat.events} 条消息；群成员：${memberCount} 人（全库 ${stats.facts} 条 / ${stats.events} 条 / ${stats.chats} 个会话）`,
				profile === '' ? '（本会话还没有画像条目）' : profile,
				'',
				'用法：/memory list ｜ /memory search <词> ｜ /memory member [昵称] ｜ /memory forget <id|昵称>（管理员）｜ /memory distill ｜ /memory reload',
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
		help: '打断当前正在跑的这一轮（不清历史、不换会话；卡住时的应急出口）',
		async run(ctx) {
			// 刻意不走 ensureAgent()：那是"确保有 agent"（缺就 resume/新建，可能
			// 等写句柄几分钟）。/stop 是应急出口，必须立刻有反应——最新状态就在
			// 桥上，句柄为空时也确实没有可打断的活动轮次。
			const stopped = ctx.bridge.abortTurn();
			await ctx.reply(
				stopped
					? '🛑 已打断这一轮（会话与上下文保留，可以直接发新消息；要清空上下文再发 /reset）'
					: '当前没有正在跑的轮次',
			);
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
		usage: '/persona [名称|reset|reload]',
		help: '查看/编辑当前会话的 SOUL.md（人格文件）；名称 = 用模板覆盖，reset = 恢复库默认，reload = 重读文件并重建 agent',
		async run(ctx) {
			const arg = ctx.arg.trim();
			const template = ctx.store.resolve(ctx.bridge.key);
			const info = inspectSoul(ctx.bridge.sessionDir, template.prompt);
			const names = ctx.store.list();
			if (arg === '') {
				const source =
					info.source === 'file'
						? 'SOUL.md'
						: info.source === 'seeded'
							? `SOUL.md（本次从模板「${template.name}」播种）`
							: info.source === 'empty'
								? 'SOUL.md 为空，当前回退模板'
								: '模板库（尚未生成 SOUL.md）';
				await ctx.reply(
					[
						`人格文件：${info.path}`,
						`生效来源：${source}`,
						`字数：${info.chars}（上限 ${MAX_SOUL_CHARS}）`,
						`模板库当前解析：${template.name}`,
						`可用模板：${names.join('、') || '（无）'}`,
						'用法：/persona <模板名>（覆盖 SOUL.md）｜ /persona reset（恢复库默认）｜ /persona reload（重读文件并重建 agent）',
					].join('\n'),
				);
				return;
			}
			if (arg === 'reload') {
				await ctx.bridge.rebuild();
				await ctx.reply('✅ 已重读 SOUL.md 并重建当前会话（历史保留）');
				return;
			}
			if (arg === 'reset' || arg === 'default') {
				const records = ctx.store.records();
				const defaultName = ctx.store.defaultPersonaName();
				const fallback = records.find((record) => record.name === defaultName) ?? records[0];
				if (fallback === undefined) {
					await ctx.reply('❌ 人格库为空，无法恢复默认');
					return;
				}
				const written = writeSoulText(ctx.bridge.sessionDir, fallback.prompt);
				if (!written.ok) {
					await ctx.reply(`❌ 写入 SOUL.md 失败：${written.error}`);
					return;
				}
				await ctx.bridge.rebuild();
				await ctx.reply(`✅ 已用默认模板「${fallback.name}」覆盖 SOUL.md，并重建当前会话`);
				return;
			}
			const record = ctx.store.records().find((entry) => entry.name === arg);
			if (record === undefined) {
				await ctx.reply(`❌ 没有人格模板 "${arg}"，可用：${names.join('、') || '（无）'}`);
				return;
			}
			if ([...record.prompt].length > MAX_SOUL_CHARS) {
				await ctx.reply(`❌ 模板「${record.name}」超过 ${MAX_SOUL_CHARS} 字，未写入 SOUL.md`);
				return;
			}
			const written = writeSoulText(ctx.bridge.sessionDir, record.prompt);
			if (!written.ok) {
				await ctx.reply(`❌ 写入 SOUL.md 失败：${written.error}`);
				return;
			}
			await ctx.bridge.rebuild();
			await ctx.reply(`✅ 已用模板「${record.name}」覆盖 SOUL.md（${[...record.prompt].length} 字），并重建当前会话`);
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
		help: '查看/管理本会话的定时任务（「直接推送」到点原样发出、不调模型；「agent 执行」到期唤醒模型）',
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
					task.delivery === 'direct' ? '· 直接推送（不调模型）' : '· agent 执行',
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
