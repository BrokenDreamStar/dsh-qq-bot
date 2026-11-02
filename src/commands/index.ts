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
import { renderSkillBody } from '../memory/rag/render.ts';

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
				`模型：${info.spec === '' ? '部署默认' : info.spec}${info.effort === undefined ? '' : `（思考强度 ${info.effort}）`}（${describeModelSource(info.source)}）`,
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
		usage: '/memory [status|search <词>|recent [n]|forget <id>|reindex|prune|setup]',
		help: '查看本会话的长期记忆：status 状态，search 检索，recent 最近片段，forget 删除片段（管理员），reindex 重建索引，prune 清理，setup 安装运行时/模型',
		async run(ctx) {
			const memory = ctx.memory;
			if (memory === undefined || !memory.ready) {
				await ctx.reply('（长期记忆未启用或存储未就绪；在 WebUI「设置 → qq-bot 配置 → 长期记忆」里打开，或检查日志）');
				return;
			}
			const [sub = '', ...rest] = ctx.arg.trim().split(/\s+/);
			const tail = rest.join(' ').trim();
			const isAdmin = (): boolean => {
				try {
					return ctx.admins.isAdmin(ctx.msg.senderId);
				} catch {
					return true;
				}
			};
			if (sub === '' || sub === 'status') {
				const status = await memory.stats?.();
				const lines = [
					`【长期记忆】${ctx.bridge.label}`,
					`状态：${status?.ready ? '就绪' : '未就绪'}；DB=${status?.db ? '✓' : '✗'} FTS=${status?.fts ? '✓' : '✗'} 向量=${status?.vec ? '✓' : '✗'} 嵌入=${status?.embed ? '✓' : '✗'} 重排=${status?.rerank ? '✓' : '✗'}`,
					`数据：${status?.messages ?? 0} 条消息 / ${status?.chunks ?? 0} 个片段 / ${status?.skills ?? 0} 个技能；运行时=${status?.runtime ?? 'unknown'}，模型=${status?.model ?? 'unknown'}`,
					...(status?.lastError !== undefined ? [`最近错误：${status.lastError}`] : []),
					'',
					'用法：/memory search <词> ｜ /memory recent ｜ /memory forget <id>（管理员）｜ /memory reindex ｜ /memory prune ｜ /memory setup',
				];
				await ctx.reply(lines.join('\n'));
				return;
			}
			if (sub === 'search') {
				if (tail === '') {
					await ctx.reply('用法：/memory search <关键词>');
					return;
				}
				const result = await memory.recall(ctx.bridge.key, tail, 8);
				await ctx.reply(result.text);
				return;
			}
			if (sub === 'recent') {
				const limit = Number.parseInt(tail, 10);
				const hits = await memory.recent?.(ctx.bridge.key, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10) ?? [];
				if (hits.length === 0) {
					await ctx.reply('（本会话还没有片段；先聊几句让记忆写入）');
					return;
				}
				const lines = [`【最近片段】${ctx.bridge.label}`];
				for (const hit of hits) {
					lines.push(`#${hit.id} [${new Date(hit.ts).toLocaleString('zh-CN')}] ${hit.text.replace(/\s*\n\s*/g, ' / ').slice(0, 160)}`);
				}
				await ctx.reply(lines.join('\n'));
				return;
			}
			if (sub === 'forget') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以删除记忆片段');
					return;
				}
				const id = Number.parseInt(tail, 10);
				if (!Number.isInteger(id) || id <= 0) {
					await ctx.reply('用法：/memory forget <片段 id>');
					return;
				}
				const deleted = await memory.deleteChunk?.(id) ?? false;
				await ctx.reply(deleted ? `✅ 已删除片段 #${id}` : `没有找到片段 #${id}`);
				return;
			}
			if (sub === 'reindex') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以重建索引');
					return;
				}
				const removed = await memory.reindex?.(ctx.bridge.key) ?? 0;
				await ctx.reply(`✅ 已重建索引（删除 ${removed} 个旧片段，后台会重新生成）`);
				return;
			}
			if (sub === 'prune') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以清理记忆');
					return;
				}
				const removed = await memory.prune?.() ?? 0;
				await ctx.reply(`✅ 已清理 ${removed} 条过期数据`);
				return;
			}
			if (sub === 'setup') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以安装运行时');
					return;
				}
				await ctx.reply('⏳ 正在安装运行时/下载模型（可能需要几分钟，进度见消息日志）…');
				const result = await memory.setup?.() ?? { installed: false, runtimeDir: '' };
				await ctx.reply(result.installed ? `✅ 运行时已就绪：${result.runtimeDir}` : '⚠️ 运行时安装失败，继续 FTS-only；详见日志');
				return;
			}
			await ctx.reply('用法：/memory [status|search <词>|recent [n]|forget <id>|reindex|prune|setup]');
		},
	},
	skill: {
		usage: '/skill [list|show <名称>|on|off|forget|promote <名称>|learn]',
		help: '查看/管理自演进技能：list 列表，show 查看全文，on/off 启停（管理员），forget 删除（管理员），promote 提升全局（管理员），learn 查看最近学习状态',
		async run(ctx) {
			const memory = ctx.memory;
			if (memory === undefined || !memory.ready) {
				await ctx.reply('（长期记忆未启用或存储未就绪）');
				return;
			}
			const [sub = 'list', ...rest] = ctx.arg.trim().split(/\s+/);
			const tail = rest.join(' ').trim();
			const isAdmin = (): boolean => {
				try {
					return ctx.admins.isAdmin(ctx.msg.senderId);
				} catch {
					return true;
				}
			};
			const findSkill = async (): Promise<{ id: number; name: string } | undefined> => {
				const skills = await memory.listSkills?.(ctx.bridge.key, true) ?? [];
				return skills.find(skill => skill.name === tail);
			};
			if (sub === 'list' || sub === '') {
				const skills = await memory.listSkills?.(ctx.bridge.key, false) ?? [];
				if (skills.length === 0) {
					await ctx.reply('（当前没有可用技能；带工具调用的成功对话后会自动学习）');
					return;
				}
				const lines = [`【技能】${ctx.bridge.label}`];
				for (const skill of skills) {
					lines.push(`- ${skill.name}（${skill.scope === 'global' ? '全局' : '本会话'}，${skill.status}，用过 ${skill.useCount} 次）：${skill.description}`);
				}
				lines.push('', '用法：/skill show <名称> ｜ /skill on|off <名称>（管理员）｜ /skill forget <名称>（管理员）｜ /skill promote <名称>（管理员）');
				await ctx.reply(lines.join('\n'));
				return;
			}
			if (sub === 'show') {
				if (tail === '') {
					await ctx.reply('用法：/skill show <名称>');
					return;
				}
				const skill = await memory.useSkill(ctx.bridge.key, tail);
				await ctx.reply(skill === undefined ? `没有找到技能「${tail}」` : renderSkillBody(skill));
				return;
			}
			if (sub === 'on' || sub === 'off') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以启停技能');
					return;
				}
				const skill = await findSkill();
				if (skill === undefined) {
					await ctx.reply(`没有找到技能「${tail}」`);
					return;
				}
				const changed = await memory.toggleSkill?.(skill.id, sub === 'on' ? 'active' : 'disabled') ?? false;
				await ctx.reply(changed ? `✅ 已${sub === 'on' ? '启用' : '停用'}「${skill.name}」` : '操作失败');
				return;
			}
			if (sub === 'forget') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以删除技能');
					return;
				}
				const skill = await findSkill();
				if (skill === undefined) {
					await ctx.reply(`没有找到技能「${tail}」`);
					return;
				}
				const deleted = await memory.deleteSkill?.(ctx.bridge.key, skill.id, `admin:${ctx.msg.senderId}`) ?? false;
				await ctx.reply(deleted ? `✅ 已删除技能「${skill.name}」` : '删除失败');
				return;
			}
			if (sub === 'promote') {
				if (!isAdmin()) {
					await ctx.reply('❌ 只有管理员可以提升全局技能');
					return;
				}
				const skill = await findSkill();
				if (skill === undefined) {
					await ctx.reply(`没有找到技能「${tail}」`);
					return;
				}
				const promoted = await memory.promoteSkill?.(ctx.bridge.key, skill.id);
				await ctx.reply(promoted === undefined ? '提升失败' : `✅ 已提升为全局技能「${promoted.name}」`);
				return;
			}
			if (sub === 'learn') {
				const error = memory.lastSkillError?.(ctx.bridge.key);
				await ctx.reply(error === undefined ? '（自动学习在带工具调用的成功轮次后触发；最近没有失败记录）' : `最近一次学习失败：${error}`);
				return;
			}
			await ctx.reply('用法：/skill [list|show <名称>|on|off|forget|promote <名称>|learn]');
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
