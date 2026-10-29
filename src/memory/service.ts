/**
 * 长期记忆服务：把纯逻辑模块（card/rank/distill/handoff/guard）与 SQLite 存储、
 * 会话桥、配置串起来，并对外提供薄接口（注入面 / 采集面 / 交接面 / 蒸馏面）。
 *
 * 与 dsh 的关系：
 *  - 卡片走 `systemPrompt.section({ order: 900 })`，`text()` **每次 assembly 求值**，
 *    所以服务内部按 `store.rev()` 缓存画像段（写入即失效），情景段每轮动态注入。
 *    避免卡片一变就打断整段前缀缓存；
 *  - 蒸馏走 `ctx.llm.stream()` 的**一次性请求**（不建 agent、不产生会话文件、
 *    可指定便宜模型、可 abort）。`llm` 是可选服务，缺失时自动蒸馏停用，
 *    工具通道与世代交接（tail 版）照常工作。
 *
 * 失败哲学：记忆不是关键路径。所有写入/检索异常都吞掉并记日志，
 * 绝不把异常抛回 QQ 消息主链路。
 */

import type { Logger } from '../types.ts';
import { buildCapacityError, canAdd, describeUsage, factText, isActiveFact, renderCard, type CardUsage } from './card.ts';
import { buildDistillPayload, DISTILL_SYSTEM_PROMPT, parseDistillOutput, shouldDistill } from './distill.ts';
import { describeFindings, scanForThreats } from './guard.ts';
import { stripQqNumbers } from './text.ts';
import { renderHandoff, shouldHandoff } from './handoff.ts';
import {
	buildMatchExpression,
	coverageOf,
	DEFAULT_PREFETCH_MIN_COVERAGE,
	FTS_CANDIDATE_LIMIT,
	normalizeBm25,
	packRecall,
	renderItemRecall,
	renderItemLine,
	renderRecall,
	scoreCandidate,
	shouldPrefetch,
	tokenizeQuery,
} from './rank.ts';
import type { MemoryStore, OpenResult } from './store.ts';
import {
	CARD_HEADER,
	MEMORY_SAFETY_NOTE,
	RECALL_HEADER,
	type HandoffInput,
	type MemoryFact,
	type MemoryKind,
	type MemoryStats,
	type MemoryStatus,
	type RecallResult,
} from './types.ts';

/** 旧结构化条目 → 记忆类型；自由文本默认按画像处理（用户显式要求记住）。 */
function kindForEntry(parsed: { predicate: string } | undefined): MemoryKind {
	if (parsed === undefined) return 'profile';
	switch (parsed.predicate) {
		case '偏好':
			return 'preference';
		case '禁忌':
			return 'rule';
		case '进行中':
		case '已决定':
			return 'plan';
		case '是':
			return 'profile';
		default:
			return 'fact';
	}
}

/** 画像段只放稳定的身份/偏好/规则/置顶条目（旧结构化条目也算画像）。 */
function isProfileFact(fact: MemoryFact): boolean {
	if (!isActiveFact(fact)) return false;
	if (fact.provenance === 'untrusted') return false;
	const kind = fact.kind ?? 'fact';
	if (kind === 'profile' || kind === 'preference' || kind === 'rule') return true;
	if (fact.pinned) return true;
	return fact.subject !== '' && fact.predicate !== '';
}

/** 记忆服务对外暴露的配置视图（由 config.ts 的 DshQQConfig 满足）。 */
export interface MemoryConfigView {
	memoryEnabled: boolean;
	memoryCardMaxChars: number;
	/** 画像段字符预算（缺省回落到 memoryCardMaxChars）。 */
	memoryProfileMaxChars?: number;
	/** 情景段字符预算（缺省回落到 memoryRecallMaxChars 与 1200 的较小值）。 */
	memoryEpisodicMaxChars?: number;
	memoryMaxFacts: number;
	memoryMaxWriteFailuresPerTurn: number;
	memoryRecallEnabled: boolean;
	memoryRecallTopK: number;
	memoryRecallMaxChars: number;
	memoryRecallHalfLifeDays: number;
	memoryPrefetch: boolean;
	memoryPrefetchMinScore: number;
	memoryPrefetchMaxItems: number;
	memoryDistillEvery: number;
	memoryDistillMinChars: number;
	memoryDistillIdleMs: number;
	memoryDistillProvider: string;
	memoryDistillModel: string;
	memoryDistillMaxTokens: number;
	/**
	 * 空输出重试预算（token；0 = 不重试）。推理模型会把预算烧在思考上、
	 * 一个字可见文本都不吐，这时用这个更大的预算再试一次。
	 */
	memoryDistillRetryTokens: number;
	memoryDistillTimeoutMs: number;
	memoryHandoffTail: number;
	memoryHandoffDistillWaitMs: number;
	memoryRetentionDays: number;
	memoryMaxEventsPerChat: number;
	/** 敏感类别过滤（默认 true）：命中即拒绝写入。 */
	memorySensitiveFilter?: boolean;
	/** 跨群/私聊共享用户画像（默认 false）。 */
	memoryCrossGroupUserProfile?: boolean;
	/** 个人事实/低置信条目先进候选区（默认 true）。 */
	memoryCandidateReview?: boolean;
	/** 每轮记录注入明细（默认开启）。 */
	memoryInjectLog?: boolean;
	/** 一般事实/事件过期天数（默认 90）。 */
	memoryFactTtlDays?: number;
	/** 用户偏好过期天数（默认 180）。 */
	memoryUserPreferenceTtlDays?: number;
	/** 删除后 tombstone 保留天数（默认 30）。 */
	memoryTombstoneDays?: number;
}

/** 蒸馏所需的最小模型面（`ctx.llm`，可选）。 */
export interface MemoryLlmView {
	stream(options: {
		provider: string;
		model: string;
		system?: string;
		messages: unknown[];
		maxTokens?: number;
		temperature?: number;
		reasoningEffort?: string;
		signal?: AbortSignal;
	}): AsyncIterable<{ type: string; text?: string; reason?: unknown; usage?: unknown }>;
	/** 模型的精确元数据（含推理档位）；老宿主可能没有这个方法。 */
	resolveModelInfo?(
		provider: string,
		model: string,
		signal?: AbortSignal,
	): Promise<{ reasoning?: { efforts?: Array<{ id?: string; name?: string }>; defaultEffort?: string } } | undefined>;
}
export interface MemoryServiceDeps {
	config: MemoryConfigView;
	logger: Logger;
	/**
	 * 打开记忆库（`<dataDir>/memory.db`）。**总开关是热应用的**：关着启动时
	 * 不建库，之后在 WebUI 打开会重新走它；关掉开关则关闭存储（库文件保留）。
	 * 缺省 = 只能由调用方显式 `attach()`（测试）。
	 */
	openStore?: () => Promise<OpenResult>;
	/** 存储就绪状态变化后的回调（打开 / 关闭 / 打开失败）；index.ts 用它同步工具注册。 */
	onStorageChange?: () => void;
	/**
	 * 诊断痕迹的出口（`index.ts` 接到消息日志：WebUI「消息日志与诊断」卡片 + NDJSON）。
	 * dsh 自己的 logger 在某些部署里不落盘，所以记忆的关键状态（存储开关、蒸馏成败）
	 * 必须有这条**用户看得见**的通道——否则失败就是黑盒。
	 */
	note?: (event: string, detail: string) => void;
	/** 惰性读取的 dsh llm 服务（可选；缺失 = 自动蒸馏停用）。 */
	getLlm?: () => MemoryLlmView | undefined;
	/** 部署默认模型（蒸馏未指定模型时用它）。 */
	getDefaultModel?: () => { provider?: string; model?: string } | undefined;
	/** 会话称呼（群 888 / 好友 12345），由 index.ts 注入。 */
	labelOf: (chatKey: string) => string;
	/** 创建一次性用户消息（dsh-llm 的 createUserMessage），由 index.ts 注入避免这里依赖 dsh-llm。 */
	createUserMessage: (text: string) => unknown;
	/** 定时兜底蒸馏的间隔（0 = 只在世代结束/手动时蒸馏）。 */
	idleSweepMs?: number;
}

/** 一次蒸馏的可用信息（世代结束时的交接要用）。 */
interface DistillRecord {
	summary?: string;
	at: number;
}

/** 单次蒸馏调用的统计（重试判定与失败诊断都用它）。 */
interface DistillAttempt {
	/** 这次调用给的输出预算。 */
	budget: number;
	/** 收到的可见文本字数。 */
	chars: number;
	/** finish chunk 的 reason（拿不到为空串）。 */
	finish: string;
	/** 模型报告的输出 token（含推理；拿不到为 undefined）。 */
	outputTokens?: number;
	/** chunk 类型计数：判断"推理有没有吐出来""是不是压根没内容"。 */
	kinds: Map<string, number>;
}

/** `max-tokens` 表示输出被预算截断：多半是推理吃掉了预算，值得放大预算重试。 */
const TRUNCATED_FINISH = 'max-tokens';

/** 重试（放大预算）时的超时上限：预算翻几倍，等待时间同比例放宽，但最多到这个上限。 */
const MAX_RETRY_TIMEOUT_MS = 120_000;
/** 重试超时相对首轮超时的最大倍数（超时是用户设的预算，别无声地放太宽）。 */
const MAX_RETRY_TIMEOUT_FACTOR = 4;
/** 一次蒸馏最多试几档预算（推理模型的思考长度未知，但不该无限往上试）。 */
export const MAX_DISTILL_ATTEMPTS = 3;

/**
 * 预算阶梯：从首轮预算按 4 倍递增，最后一档一定落在上限上。
 *
 * 例：`800 → 3200 → 16000`、`4000 → 16000`、`16000 → [16000]`（首轮已在上限）。
 * 推理模型的思考长度事先未知，一次试不出来就再来一档——比"只重试一次"更容易
 * 收敛，也比"直接给最大预算"少烧 token（本地模型只影响延迟）。
 */
export function buildBudgetLadder(first: number, ceiling: number, maxSteps = MAX_DISTILL_ATTEMPTS): number[] {
	const start = Math.max(128, Math.trunc(first));
	const top = Math.max(start, Math.trunc(ceiling));
	const steps = [start];
	while (steps.length < Math.max(1, maxSteps) - 1 && steps[steps.length - 1]! < top) {
		const last = steps[steps.length - 1]!;
		steps.push(Math.min(top, Math.max(last + 1, last * 4)));
	}
	if (steps[steps.length - 1]! < top) steps.push(top);
	return steps;
}

/**
 * 这次尝试是不是"预算被吃光"（而不是模型真的没话说）。
 *
 * 判据：`finish=max-tokens`（被截断），或 0 可见字却报出了接近预算的输出 token
 * （全在推理上）。只有这种失败才值得抬高下次的首轮预算——超时/调用错误不算。
 */
function exhaustedBudget(attempt: DistillAttempt | undefined): boolean {
	if (attempt === undefined) return false;
	if (attempt.finish === TRUNCATED_FINISH) return true;
	return (
		attempt.chars === 0 && attempt.outputTokens !== undefined && attempt.outputTokens >= attempt.budget * 0.9
	);
}

/**
 * finish chunk 的 reason。
 *
 * 老宿主是字符串（`'max-tokens'`），dsh ≥ 0.1.7 是对象（`{ kind: 'max-tokens' }`）；
 * 两种都认，认不出来返回空串（不猜）。
 */
function finishKind(reason: unknown): string {
	if (typeof reason === 'string') return reason;
	if (reason !== null && typeof reason === 'object') {
		const kind = (reason as { kind?: unknown }).kind;
		if (typeof kind === 'string') return kind;
	}
	return '';
}

/** usage chunk 里的输出 token 数（老/新宿主字段名一致，拿不到就 undefined）。 */
function usageOutputTokens(usage: unknown): number | undefined {
	if (usage === null || typeof usage !== 'object') return undefined;
	const value = (usage as { outputTokens?: unknown }).outputTokens;
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 把若干次尝试压成一行可读诊断（失败原因里给用户看）。 */
function describeAttempts(attempts: DistillAttempt[]): string {
	if (attempts.length === 0) return '一次调用都没发出去';
	return attempts
		.map((attempt, index) => {
			const bits = [`第 ${index + 1} 次 ${attempt.budget} token → 可见 ${attempt.chars} 字`];
			if (attempt.finish !== '') bits.push(`finish=${attempt.finish}`);
			if (attempt.outputTokens !== undefined) {
				bits.push(
					attempt.chars === 0 && attempt.outputTokens > 0
						? `输出 ${attempt.outputTokens} token 全在推理上`
						: `输出 ${attempt.outputTokens} token`,
				);
			}
			if (attempt.kinds.size > 0) {
				bits.push([...attempt.kinds].map(([kind, count]) => `${kind}×${count}`).join(' '));
			}
			return bits.join('，');
		})
		.join('；');
}

/** 蒸馏的推理档位选择结果（`offered` 只用于失败诊断）。 */
interface DistillEffort {
	effort?: string;
	/**
	 * `yes` = 宿主为这个模型暴露了推理档位；`none` = 明确没有（手工声明的模型常见）；
	 * `unknown` = 拿不到元数据（老宿主没有 resolveModelInfo / 查询失败），别当成"没有"。
	 */
	offered: 'yes' | 'none' | 'unknown';
}

export class MemoryService {
	private store: MemoryStore | undefined;
	/** 每个 chatKey 的画像段缓存：`rev` 变化即失效（写入后立刻可见）。 */
	private readonly profileCache = new Map<string, { rev: number; text: string }>();
	/** 本进程见过的 chatKey（空闲兜底扫描用）。 */
	private readonly seenChats = new Set<string>();
	/** 每个 chatKey 上一次蒸馏的摘要（交接块用）。 */
	private readonly distillRecords = new Map<string, DistillRecord>();
	/** 正在跑的蒸馏（同一 chatKey 串行化，防重入）。 */
	private readonly inflight = new Map<string, Promise<boolean>>();
	/** 每轮 qq_memorize 的失败计数（每轮由 bridge 重置）。 */
	private readonly writeFailures = new Map<string, number>();
	/** 上一次蒸馏尝试时间（批量阈值 + 失败退避用）。 */
	private readonly lastAttempt = new Map<string, number>();
	/** 上一次成功蒸馏/首次见到消息的时间（空闲兜底判据）。 */
	private readonly lastDistillAt = new Map<string, number>();
	/** 上一次定期 prune 的时间（60s 扫描里每 10 分钟跑一次）。 */
	private lastPruneAt = 0;
	/** 连续失败次数（退避用）。 */
	private readonly failures = new Map<string, number>();
	private idleTimer: ReturnType<typeof setInterval> | null = null;
	/** 每个 chatKey 最近一次蒸馏失败的原因（`/memory distill` 直接回给用户）。 */
	private readonly distillErrors = new Map<string, string>();
	/**
	 * 每个 chatKey 最近一次蒸馏里"没东西可记"的说明（`/memory distill` 用它区分
	 * "压根没有新消息"与"模型看过这批消息、认为不值得记"——两种情况都返回 false，
	 * 之前只能靠猜；见 `lastDistillNote()`）。
	 */
	private readonly distillNotes = new Map<string, string>();
	/**
	 * 上次**成功**过的输出预算（跨会话共用：预算需求是模型的属性，不是会话的）。
	 * 推理模型首轮被推理吃光预算时，靠它把下一轮的首轮预算直接提到够用的档位，
	 * 不必每次都白烧一次小预算；配置一改（`reconfigure()`）就清零重学。
	 */
	private distillBudget = 0;

	constructor(private readonly deps: MemoryServiceDeps) {}

	/** 记一条诊断痕迹（消息日志里可见；出口异常绝不影响记忆本身）。 */
	private trace(event: string, detail: string): void {
		try {
			this.deps.note?.(event, detail);
		} catch {
			// 诊断通道的问题不该影响功能。
		}
	}

	/** 绑定存储（打开成功后调用）。 */
	attach(store: MemoryStore): void {
		this.store = store;
		this.startIdleSweep();
	}

	/** 解绑并关闭存储（关掉总开关时调用；库文件保留，重新打开即恢复）。 */
	detach(): void {
		this.stopIdleSweep();
		const store = this.store;
		this.store = undefined;
		store?.close();
	}

	dispose(): void {
		this.detach();
	}

	private startIdleSweep(): void {
		if (this.idleTimer !== null) return;
		// 固定 60s 心跳：`memoryDistillIdleMs` 是热配置，不能在构造时快照成定时器间隔。
		// 心跳同时承担定期 prune；空闲阈值在实际判定时实时读取。
		const configured = this.deps.idleSweepMs ?? 0;
		const interval = configured > 0 ? Math.min(configured, 60_000) : 60_000;
		this.idleTimer = setInterval(() => {
			void this.sweepIdle();
		}, interval);
		// 定时器不能拖住进程退出。
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	private stopIdleSweep(): void {
		if (this.idleTimer !== null) clearInterval(this.idleTimer);
		this.idleTimer = null;
	}

	/**
	 * 是否可用：总开关打开**且**存储就绪。
	 *
	 * 开关是热应用的（见 `reconfigure()`），所以这里实时求值，
	 * 不能用构造时快照的值。
	 */
	get ready(): boolean {
		return this.config.memoryEnabled === true && this.store !== undefined;
	}

	/**
	 * 让存储状态与总开关保持一致：开 → 打开库（不存在则创建），关 → 关闭存储。
	 *
	 * @returns 状态是否真的变了（调用方据此决定要不要同步工具注册）。
	 */
	private async alignStorage(): Promise<boolean> {
		const wantOpen = this.config.memoryEnabled === true;
		if (wantOpen === (this.store !== undefined)) return false;
		if (!wantOpen) {
			this.detach();
			this.logger.info('dsh-qq-bot: 长期记忆已停用，存储已关闭（库文件保留，重新打开即恢复）');
			this.trace('memory-off', '长期记忆已停用：存储已关闭（库文件保留，重新打开即恢复）');
			return true;
		}
		const opened = await this.deps.openStore?.();
		if (opened === undefined) return false;
		if (!opened.ok) {
			this.logger.warn(`dsh-qq-bot: 长期记忆已启用但存储不可用，本功能停用（其它功能不受影响）：${opened.reason}`);
			this.trace('memory-error', `长期记忆已启用但存储不可用，本功能停用：${opened.reason}`);
			return false;
		}
		this.attach(opened.store);
		this.logger.info('dsh-qq-bot: 长期记忆存储已打开');
		this.trace('memory-on', '长期记忆已启用：记忆库已打开（采集/卡片/检索/蒸馏开始工作）');
		return true;
	}

	/** 插件装配期按总开关打开存储（不通知 onStorageChange：调用方的工具注册还没接好）。 */
	async openIfEnabled(): Promise<void> {
		await this.alignStorage();
	}

	private get config(): MemoryConfigView {
		return this.deps.config;
	}

	private get logger(): Logger {
		return this.deps.logger;
	}

	stats(): MemoryStats {
		const stats = this.store?.stats() ?? { enabled: false, chats: 0, facts: 0, events: 0, rev: 0 };
		return { ...stats, enabled: this.ready };
	}

	/** 该会话的事实条数（诊断/日志用）。 */
	chatStats(chatKey: string): { facts: number; events: number } {
		return this.store?.chatStats(chatKey) ?? { facts: 0, events: 0 };
	}

	/** 列记忆条目（`/memory list` 与 WebUI 用）。 */
	listItems(chatKey: string, options: { query?: string; status?: 'active' | 'pending' | 'superseded' | 'archived' | 'deleted' | 'all'; limit?: number } = {}): MemoryFact[] {
		return this.store?.listItems(chatKey, options) ?? [];
	}

	/** 删除一条记忆（软删 + tombstone；返回是否成功）。 */
	deleteItem(chatKey: string, id: number, actor: string): boolean {
		const removed = this.store?.deleteFact(chatKey, id, actor) ?? false;
		if (removed) this.unfreeze(chatKey);
		return removed;
	}

	/** WebUI 保存：id 存在则改正文/元数据，否则新增一条（走 qq_memorize 的同一套校验）。 */
	saveItem(
		chatKey: string,
		input: { id?: number; content: string; kind?: MemoryKind; importance?: number; pinned?: boolean; status?: MemoryStatus },
		actor: string,
	): { ok: true } | { ok: false; error: string } {
		const store = this.store;
		if (!this.ready || store === undefined) return { ok: false, error: '长期记忆当前不可用' };
		const content = stripQqNumbers(input.content.trim());
		if (content === '') return { ok: false, error: '内容不能为空' };
		if (input.id !== undefined) {
			const updated = store.updateFact(chatKey, input.id, content);
			if ('error' in updated) return { ok: false, error: updated.error };
			store.updateItemMeta(chatKey, input.id, {
				...(input.kind !== undefined ? { kind: input.kind } : {}),
				...(input.importance !== undefined ? { importance: input.importance } : {}),
				...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
				...(input.status !== undefined ? { status: input.status } : {}),
			});
			this.unfreeze(chatKey);
			this.logger.info(`dsh-qq-bot: 记忆条目 #${input.id} 已由 ${actor} 更新`);
			return { ok: true };
		}
		const added = this.memorize({ chatKey, action: 'add', content, ...(input.kind !== undefined ? { kind: input.kind } : {}) });
		return added.ok ? { ok: true } : { ok: false, error: added.error };
	}

	/** 审计日志（WebUI 用）。 */
	auditLog(chatKey: string, limit = 100): Array<Record<string, unknown>> {
		return this.store?.auditLog(chatKey, limit) ?? [];
	}

	/** 测试召回：返回画像段 + 本轮情景段（WebUI「测试召回」用）。 */
	preview(chatKey: string, query: string): { profile: string; episodic: string } {
		return { profile: this.cardSection(chatKey), episodic: this.prefetch(chatKey, query) };
	}

	// ── 采集面 ────────────────────────────────────────────────

	/**
	 * 记一条消息（入站或机器人自己的回复）。
	 *
	 * @returns 落库后的 seq；未启用/失败返回 undefined（调用方忽略即可）。
	 */
	record(event: {
		chatKey: string;
		generation: string;
		ts?: number;
		senderId: string;
		senderName: string;
		self?: boolean;
		kind?: 'chat' | 'reply';
		text: string;
		msgId?: string;
	}): number | undefined {
		if (!this.ready) return undefined;
		const text = event.text.trim();
		if (text === '') return undefined;
		this.noteChat(event.chatKey);
		// 空闲兜底从「第一次见到这条会话」开始计时；否则 last 为空会让 10 分钟判定永远不触发。
		if (!this.lastDistillAt.has(event.chatKey)) this.lastDistillAt.set(event.chatKey, Date.now());
		// 登记当前世代：世代交接靠它判断"换了新会话"，所以要在**每条事件**上刷新，
		// 不能只在交接时写 —— 否则进程重启后继续同一世代时会被误判成新世代。
		if (this.store?.lastSessionId(event.chatKey) !== event.generation) {
			this.store?.setLastSessionId(event.chatKey, event.generation);
		}
		const seq = this.store?.insertEvent({
			chatKey: event.chatKey,
			generation: event.generation,
			ts: event.ts ?? Date.now(),
			senderId: event.senderId,
			senderName: event.senderName,
			self: event.self === true,
			kind: event.kind ?? 'chat',
			text,
			...(event.msgId !== undefined && event.msgId !== '' ? { msgId: event.msgId } : {}),
		});
		if (seq !== undefined) this.scheduleBatchDistill(event.chatKey);
		return seq;
	}

	// ── 注入面（system prompt） ─────────────────────────────────

	/**
	 * 画像段 section 文本（稳定层）：只放身份/偏好/规则/置顶条目。
	 *
	 * 不再"会话内冻结"：按 `store.rev()` 缓存，写入/蒸馏后 rev 变化，
	 * 下一轮系统提示就能看到新内容。情景层由 `prefetch()` 每轮动态注入。
	 */
	cardSection(chatKey: string): string {
		if (!this.ready) return '';
		const store = this.store;
		if (store === undefined) return '';
		const rev = store.rev(chatKey);
		const cached = this.profileCache.get(chatKey);
		if (cached !== undefined && cached.rev === rev) return cached.text;
		const facts = store.facts(chatKey).filter(isProfileFact);
		const text = renderCard(facts, {
			maxChars: this.config.memoryProfileMaxChars ?? this.config.memoryCardMaxChars,
			chatLabel: this.deps.labelOf(chatKey),
		}).text;
		this.profileCache.set(chatKey, { rev, text });
		return text;
	}

	/** 清画像缓存（写入/世代切换/手动 /memory reload 时调用；无冻结语义）。 */
	unfreeze(chatKey: string): void {
		this.profileCache.delete(chatKey);
	}

	/** 能力提示 section：告诉模型记忆怎么用（工具没注册时返回空串）。 */
	guidanceSection(available: boolean): string {
		if (!this.ready || !available) return '';
		const lines = [
			`你有一份本会话的长期记忆画像（系统提示里的「${CARD_HEADER}」块），它记录了这个会话里跨天仍然成立的身份、偏好与规则。`,
			'与本轮问题相关的历史事件会由系统自动召回（不需要你调用工具）；需要深挖更早的细节时用 qq_recall_memory。',
			'当你了解到值得长期记住的信息（人物身份、群里的偏好与规矩、长期事项与决定、明确禁忌）时，用 qq_memorize 记下来，下一轮起生效；一次性的闲聊不要记。',
			MEMORY_SAFETY_NOTE,
		];
		return lines.join('\n');
	}

	// ── 检索面 ────────────────────────────────────────────────

	/** 共用的一次检索（工具召回与每轮预取都走它，避免两处逻辑漂移）。 */
	private recallPacked(
		chatKey: string,
		query: string,
		options: { topK: number; maxChars: number },
	): { packed: ReturnType<typeof packRecall>; candidates: number; now: number; match: string | undefined } | undefined {
		const store = this.store;
		if (!this.ready || store === undefined) return undefined;
		const tokens = tokenizeQuery(query);
		const match = buildMatchExpression(query);
		const now = Date.now();
		if (match === undefined || tokens.length === 0) {
			return { packed: { selected: [], dropped: 0 }, candidates: 0, now, match: undefined };
		}
		const hits = store.searchEvents(chatKey, match, FTS_CANDIDATE_LIMIT);
		// BM25 绝对值只有 1e-6 量级，必须按批归一后才能当"相关度"用（见 rank.ts）。
		const normalized = normalizeBm25(hits);
		const candidates = hits.map((hit, index) => {
			// 覆盖率：正文为主、说话人次之（"张三说了什么"这类查询靠后者）。
			const coverage = coverageOf(tokens, hit.event.text) * 0.7 + coverageOf(tokens, hit.event.senderName) * 0.3;
			return {
				event: hit.event,
				bm25: hit.bm25,
				coverage,
				score: scoreCandidate({
					bm25Norm: normalized[index] ?? 0,
					ts: hit.event.ts,
					now,
					coverage,
					halfLifeDays: this.config.memoryRecallHalfLifeDays,
				}),
			};
		});
		const packed = packRecall(candidates, {
			topK: Math.max(1, Math.trunc(options.topK)),
			maxChars: options.maxChars,
			now,
		});
		return { packed, candidates: candidates.length, now, match };
	}

	/** 记忆条目检索（整理后的事实；与原始消息档案分开打分/渲染）。 */
	private recallItemFacts(
		chatKey: string,
		query: string,
		options: { topK: number; maxChars: number },
	): { facts: MemoryFact[]; candidates: number; match: string | undefined; now: number; bestScore: number } {
		const store = this.store;
		const now = Date.now();
		if (!this.ready || store === undefined) return { facts: [], candidates: 0, match: undefined, now, bestScore: 0 };
		const tokens = tokenizeQuery(query);
		const match = buildMatchExpression(query);
		if (match === undefined || tokens.length === 0) return { facts: [], candidates: 0, match: undefined, now, bestScore: 0 };
		const hits = store.searchItems(chatKey, match, FTS_CANDIDATE_LIMIT);
		const normalized = normalizeBm25(hits);
		const scored = hits.map((hit, index) => {
			const coverage = coverageOf(tokens, factText(hit.fact));
			return {
				fact: hit.fact,
				coverage,
				score: scoreCandidate({
					bm25Norm: normalized[index] ?? 0,
					ts: hit.fact.updatedAt,
					now,
					coverage,
					halfLifeDays: this.config.memoryRecallHalfLifeDays,
					importance: hit.fact.importance,
				}),
			};
		});
		scored.sort((a, b) => b.score - a.score);
		const selected: MemoryFact[] = [];
		let used = 0;
		for (const item of scored) {
			if (selected.length >= Math.max(1, Math.trunc(options.topK))) break;
			const cost = renderItemLine(item.fact, now).length + 1;
			if (selected.length > 0 && used + cost > options.maxChars) break;
			selected.push(item.fact);
			used += cost;
		}
		return { facts: selected, candidates: scored.length, match, now, bestScore: scored[0]?.score ?? 0 };
	}

	/** `qq_recall_memory` 的实现：先查整理后的条目，再补原始消息档案。 */
	recall(chatKey: string, query: string, count?: number): RecallResult {
		const topK = Math.min(Math.max(1, Math.trunc(count ?? this.config.memoryRecallTopK)), this.config.memoryRecallTopK);
		const items = this.recallItemFacts(chatKey, query, { topK, maxChars: Math.floor(this.config.memoryRecallMaxChars * 0.6) });
		const events = this.recallPacked(chatKey, query, {
			topK: Math.max(1, topK - items.facts.length),
			maxChars: Math.max(200, this.config.memoryRecallMaxChars - items.facts.reduce((total, fact) => total + renderItemLine(fact, items.now).length + 1, 0)),
		});
		if (items.match === undefined && events?.match === undefined) {
			return {
				text: `${RECALL_HEADER}查询里没有可用于检索的关键词，请换用具体的词（人名、项目名、关键词）。`,
				count: 0,
				candidates: 0,
			};
		}
		if (events === undefined) return { text: '（长期记忆当前不可用）', count: 0, candidates: 0 };
		const parts: string[] = [];
		if (items.facts.length > 0) parts.push(renderItemRecall(items.facts, { chatLabel: this.deps.labelOf(chatKey), query, now: items.now }));
		if (events.packed.selected.length > 0) parts.push(renderRecall(events.packed, { chatLabel: this.deps.labelOf(chatKey), query, now: events.now }));
		if (parts.length === 0) {
			parts.push(`${RECALL_HEADER}在${this.deps.labelOf(chatKey)}的记忆里没有找到与「${query}」相关的记录。可以换个说法再查，或直接问用户。`);
		}
		return { text: parts.join('\n\n'), count: items.facts.length + events.packed.selected.length, candidates: items.candidates + events.candidates };
	}

	/**
	 * 每轮预取：先按本轮用户文本召回整理后的条目，没有合适条目再回落到原始消息。
	 *
	 * @returns 注入用的数据块；不需要注入时返回空串。
	 */
	prefetch(chatKey: string, query: string): string {
		if (!this.ready || !this.config.memoryPrefetch) return '';
		if (this.config.memoryPrefetchMaxItems <= 0) return '';
		const maxChars = Math.min(this.config.memoryEpisodicMaxChars ?? this.config.memoryRecallMaxChars, 1200);
		const items = this.recallItemFacts(chatKey, query, { topK: this.config.memoryPrefetchMaxItems, maxChars });
		if (items.facts.length > 0 && items.bestScore >= this.config.memoryPrefetchMinScore * 0.8) {
			if (this.config.memoryInjectLog !== false) {
				this.trace(
					'memory-inject',
					`${this.deps.labelOf(chatKey)}：注入 ${items.facts.length} 条记忆（#${items.facts.map((fact) => fact.id).join(', #')}，最高分 ${items.bestScore.toFixed(2)}，预算 ${maxChars} 字）`,
				);
			}
			return renderItemRecall(items.facts, { chatLabel: this.deps.labelOf(chatKey), query, now: items.now });
		}
		const result = this.recallPacked(chatKey, query, {
			topK: this.config.memoryPrefetchMaxItems,
			maxChars: Math.min(maxChars, 900),
		});
		if (result === undefined || result.match === undefined) return '';
		if (!shouldPrefetch(result.packed, this.config.memoryPrefetchMinScore, { minCoverage: DEFAULT_PREFETCH_MIN_COVERAGE })) return '';
		if (this.config.memoryInjectLog !== false) {
			this.trace(
				'memory-inject',
				`${this.deps.labelOf(chatKey)}：注入 ${result.packed.selected.length} 条原始消息（seq ${result.packed.selected.map((item) => item.event.seq).join(',')}，预算 ${maxChars} 字）`,
			);
		}
		return renderRecall(result.packed, { chatLabel: this.deps.labelOf(chatKey), query, now: result.now });
	}

	// ── 写入面（工具） ─────────────────────────────────────────

	/** `qq_memorize` 的实现（容量满时报错并带回当前条目）。 */
	memorize(input: {
		chatKey: string;
		action: 'add' | 'replace' | 'remove';
		content?: string;
		oldText?: string;
		kind?: MemoryKind;
	}): { ok: true; text: string } | { ok: false; error: string; usage?: CardUsage } {
		const store = this.store;
		if (!this.ready || store === undefined) return { ok: false, error: '长期记忆当前不可用（未启用或存储不可用）' };
		const facts = store.facts(input.chatKey);
		const profileBudget = this.config.memoryProfileMaxChars ?? this.config.memoryCardMaxChars;
		const profileFacts = facts.filter(isProfileFact);
		const usage = describeUsage(profileFacts, profileBudget);

		if (input.action === 'add') {
			const content = stripQqNumbers(input.content?.trim() ?? '');
			if (content === '') return { ok: false, error: 'add 需要 content（要记住的内容）' };
			const verdict = scanForThreats(content);
			if (!verdict.ok) return { ok: false, error: `内容命中安全扫描（${describeFindings(verdict.findings)}），已拒绝写入` };
			if (!canAdd(profileFacts, profileBudget, content)) {
				if (this.tooManyWriteFailures(input.chatKey)) {
					return { ok: false, error: '本轮整理记忆的尝试次数已用完，请先继续对话，下一轮再整理。', usage };
				}
				return { ok: false, error: buildCapacityError(usage, content.length), usage };
			}
			const parsed = splitEntry(content);
			const added = store.addFact({
				chatKey: input.chatKey,
				...(parsed !== undefined ? { subject: parsed.subject, predicate: parsed.predicate, object: parsed.object } : {}),
				content,
				kind: input.kind ?? kindForEntry(parsed),
				provenance: 'owner',
				confidence: 0.95,
				actor: 'user',
			});
			if ('error' in added) return { ok: false, error: added.error, usage };
			store.enforceFactLimit(input.chatKey, this.config.memoryMaxFacts);
			this.unfreeze(input.chatKey);
			const after = describeUsage(store.facts(input.chatKey).filter(isProfileFact), profileBudget);
			return { ok: true, text: `已记住（本轮起生效）：${content}（画像 ${after.label} 字）` };
		}

		const oldText = stripQqNumbers(input.oldText?.trim() ?? '');
		if (oldText === '') return { ok: false, error: `${input.action} 需要 old_text（能唯一定位条目的短子串）` };
		const matches = facts.filter((fact) => isActiveFact(fact) && factText(fact).includes(oldText));
		if (matches.length === 0) {
			return { ok: false, error: `没有条目包含「${oldText}」。当前条目见 usage.current_entries。`, usage };
		}
		if (matches.length > 1) {
			return { ok: false, error: `「${oldText}」匹配到 ${matches.length} 条，请换更具体的子串。当前条目见 usage.current_entries。`, usage };
		}
		const target = matches[0]!;
		if (input.action === 'remove') {
			if (!store.deleteFact(input.chatKey, target.id, 'user')) return { ok: false, error: '删除失败（详见日志）', usage };
			this.unfreeze(input.chatKey);
			return { ok: true, text: `已删除：「${factText(target)}」（当前 ${describeUsage(store.facts(input.chatKey).filter(isProfileFact), this.config.memoryProfileMaxChars ?? this.config.memoryCardMaxChars).label} 字）。` };
		}
		const content = stripQqNumbers(input.content?.trim() ?? '');
		if (content === '') return { ok: false, error: 'replace 需要 content（改写后的内容）' };
		const parsed = splitEntry(content);
		const added = store.addFact({
			chatKey: input.chatKey,
			...(parsed !== undefined ? { subject: parsed.subject, predicate: parsed.predicate, object: parsed.object } : {}),
			content,
			kind: input.kind ?? target.kind ?? kindForEntry(parsed),
			provenance: 'owner',
			confidence: 0.95,
			actor: 'user',
		});
		if ('error' in added) return { ok: false, error: added.error, usage };
		if (added.id !== target.id) store.supersedeFact(input.chatKey, target.id, added.id);
		store.enforceFactLimit(input.chatKey, this.config.memoryMaxFacts);
		this.unfreeze(input.chatKey);
		return { ok: true, text: `已更新为：「${content}」（本轮起生效，当前 ${describeUsage(store.facts(input.chatKey).filter(isProfileFact), this.config.memoryProfileMaxChars ?? this.config.memoryCardMaxChars).label} 字）。` };
	}

	/** 每轮开始时清空写入失败计数（bridge 在 handleMessage 里调用）。 */
	resetTurnWriteFailures(chatKey: string): void {
		this.writeFailures.delete(chatKey);
	}

	private tooManyWriteFailures(chatKey: string): boolean {
		const count = (this.writeFailures.get(chatKey) ?? 0) + 1;
		this.writeFailures.set(chatKey, count);
		return count > Math.max(0, this.config.memoryMaxWriteFailuresPerTurn);
	}

	// ── 世代交接 ──────────────────────────────────────────────

	/**
	 * 新世代第一轮调用：判断是否换了世代，是则产出一份交接块。
	 *
	 * 幂等：内部按 `handed:<chatKey>` 记录已交接过的 sessionId，
	 * 同一个世代只会拿到一次交接（reset/重启两条路径共用）。
	 */
	async takeHandoff(chatKey: string, sessionId: string): Promise<string> {
		const store = this.store;
		if (!this.ready || store === undefined) return '';
		// 幂等：交接是"每个世代一次"的仪式，用 handed:<chatKey> 单独记账
		// （session:<chatKey> 记录的是"当前世代"，每条事件都会刷新，不能当幂等标记用）。
		if (store.handedGeneration(chatKey) === sessionId) return '';
		store.setHandedGeneration(chatKey, sessionId);
		// "换了世代"的判据 = 库里存在**别的世代**的事件。首次接触时没有 → 不交接。
		const anchorEvent = store.lastEvent(chatKey, sessionId);
		if (anchorEvent === undefined) return '';
		const tailCount = Math.max(0, Math.trunc(this.config.memoryHandoffTail));
		const tail = tailCount === 0 ? [] : store.recentEvents(chatKey, tailCount, sessionId);
		const previous = anchorEvent.generation;
		const record = this.distillRecords.get(chatKey);
		const input: HandoffInput = {
			chatLabel: this.deps.labelOf(chatKey),
			lastActivityAt: anchorEvent.ts,
			lastSessionId: previous,
			tail,
			...(record?.summary !== undefined ? { summary: record.summary } : {}),
		};
		if (!shouldHandoff(input)) return '';
		return renderHandoff(input);
	}

	/**
	 * fork 用完整原文继承了上一段：把这个新 sessionId 记为已交接，
	 * 避免新世代第一轮再注入一份摘要（与 fork 的历史重复）。
	 */
	markHanded(chatKey: string, sessionId: string): void {
		this.store?.setHandedGeneration(chatKey, sessionId);
	}

	/**
	 * 世代结束（/reset 前）调用：尽力把这一段对话蒸馏掉，再写交接锚点。
	 *
	 * 超时（`memoryHandoffDistillWaitMs`）不等——交接块的 tail 不依赖 LLM，
	 * 先把 tail 用上，蒸馏完成后再更新卡片。
	 */
	async onGenerationEnd(chatKey: string, options: { force?: boolean } = {}): Promise<void> {
		if (!this.ready) return;
		const waitMs = Math.max(0, Math.trunc(this.config.memoryHandoffDistillWaitMs));
		const run = this.distill(chatKey, { force: options.force === true });
		if (waitMs === 0) {
			void run;
			return;
		}
		await Promise.race([run, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
	}

	// ── 蒸馏 ─────────────────────────────────────────────────

	/**
	 * 批量阈值的即时触发：**延迟一拍**再判断。
	 *
	 * 为什么不在 `record()` 里直接判断：一轮对话往往连续写入多条事件（成员发言、
	 * 机器人回复），立刻开蒸馏只会看到第一条，水位线推到 seq 1 —— 等于每次记账
	 * 都少算后面几条。推迟一个宏任务，等价于"这一批写完再看"，成本几乎为零。
	 */
	private scheduleBatchDistill(chatKey: string): void {
		if (!this.ready) return;
		setTimeout(() => {
			const force = this.idleDue(chatKey);
			if (this.shouldDistillNow(chatKey, force)) void this.distill(chatKey, { force });
		}, 50).unref?.();
	}

	/** 距上次成功蒸馏（或首次见到消息）是否已经超过空闲阈值。 */
	private idleDue(chatKey: string): boolean {
		const idleMs = Math.max(0, Math.trunc(this.config.memoryDistillIdleMs));
		if (idleMs <= 0) return false;
		const last = this.lastDistillAt.get(chatKey);
		if (last === undefined) return false;
		return Date.now() - last >= idleMs;
	}

	/** 是否满足批量阈值（供 record 里的即时判断）；`force` = 空闲兜底/手动。 */
	private shouldDistillNow(chatKey: string, force = false): boolean {
		const store = this.store;
		if (store === undefined || !this.config.memoryEnabled) return false;
		if (this.deps.getLlm?.() === undefined) return false;
		if (this.inflight.has(chatKey)) return false;
		const last = this.lastAttempt.get(chatKey) ?? 0;
		const failures = this.failures.get(chatKey) ?? 0;
		// 失败退避：连续失败后 10 分钟内不再自动尝试。
		if (failures > 0 && Date.now() - last < 600_000) return false;
		const watermark = store.watermark(chatKey);
		const events = store.eventsAfter(chatKey, watermark, 200).filter((event) => !event.self);
		if (events.length === 0) return false;
		const chars = events.reduce((total, event) => total + event.text.length, 0);
		return shouldDistill({
			newEvents: events.length,
			newChars: chars,
			minEvents: this.config.memoryDistillEvery,
			minChars: this.config.memoryDistillMinChars,
			force,
		});
	}

	/** 空闲兜底扫描：对所有有未蒸馏事件的会话尝试一次；顺带定期 prune。 */
	private async sweepIdle(): Promise<void> {
		const store = this.store;
		if (store === undefined || !this.ready) return;
		const now = Date.now();
		const idleMs = Math.max(0, Math.trunc(this.config.memoryDistillIdleMs));
		for (const chatKey of this.knownChats()) {
			// 重启后 lastDistillAt 是空的：从「现在 - 空闲阈值」起步，避免永远不触发。
			if (!this.lastDistillAt.has(chatKey) && idleMs > 0) this.lastDistillAt.set(chatKey, now - idleMs);
			const force = this.idleDue(chatKey);
			if (this.shouldDistillNow(chatKey, force)) await this.distill(chatKey, { force });
		}
		if (now - this.lastPruneAt >= 10 * 60_000) {
			this.lastPruneAt = now;
			store.prune();
			// prune 可能归档过期条目；清画像缓存，下一轮重新渲染。
			this.profileCache.clear();
		}
	}

	/** 已知的会话键集合：内存里见过的 + 库里还有未蒸馏事件的（重启后前者是空的）。 */
	private knownChats(): string[] {
		const keys = new Set(this.seenChats);
		for (const chatKey of this.store?.pendingChats() ?? []) keys.add(chatKey);
		return [...keys];
	}

	/**
	 * 跑一次蒸馏（同一 chatKey 串行；已有在跑则复用它）。
	 *
	 * @returns 是否真的落库了修改。
	 */
	async distill(chatKey: string, options: { force?: boolean } = {}): Promise<boolean> {
		const existing = this.inflight.get(chatKey);
		if (existing !== undefined) return existing;
		const run = this.runDistill(chatKey, options).finally(() => {
			this.inflight.delete(chatKey);
		});
		this.inflight.set(chatKey, run);
		return run;
	}

	private async runDistill(chatKey: string, options: { force?: boolean }): Promise<boolean> {
		const store = this.store;
		const llm = this.deps.getLlm?.();
		if (store === undefined || !this.ready) return false;
		if (llm === undefined || typeof llm.stream !== 'function') {
			// 旧宿主 / TUI 没有 llm 服务：工具通道与交接照常，只少了自动学习。这条必须留痕，
			// 否则「为什么记忆不自己更新」永远查不出来。
			this.noteFailure(chatKey, '蒸馏不可用：dsh llm 服务缺失（工具写入与世代交接不受影响）');
			return false;
		}
		const watermark = store.watermark(chatKey);
		const allEvents = store.eventsAfter(chatKey, watermark, 500);
		// 机器人自己的回复只进档案供检索，不作为事实抽取的来源（否则会"自产自销"）。
		const events = allEvents.filter((event) => !event.self);
		if (!shouldDistill({
			newEvents: events.length,
			newChars: events.reduce((total, event) => total + event.text.length, 0),
			minEvents: this.config.memoryDistillEvery,
			minChars: this.config.memoryDistillMinChars,
			force: options.force === true,
		})) {
			// 同上：没调模型就不是失败，但要说清"为什么什么都没做"。
			this.noteSkipped(chatKey, events.length === 0 ? '这条会话在上次蒸馏之后还没有新消息' : '新消息还没到蒸馏阈值');
			return false;
		}
		this.distillNotes.delete(chatKey);
		this.lastAttempt.set(chatKey, Date.now());
		const model = this.resolveDistillModel();
		if (model === undefined) {
			this.noteFailure(chatKey, '没有可用的模型：部署默认模型与 memoryDistillProvider/Model 都为空');
			return false;
		}
		const facts = store.facts(chatKey).filter((fact) => fact.status === undefined || fact.status === 'active');
		const input = {
			chatKey,
			chatLabel: this.deps.labelOf(chatKey),
			existing: facts,
			events,
			limits: { maxNewFacts: 5, objectMaxChars: 240, contentMaxChars: 240 },
		};
		const payload = buildDistillPayload(input);
		// 推理档位：机械抽取不需要长推理。有的模型默认档会把整个 token 预算
		// 烧在 reasoning 上、可见文本一个字都不吐。元数据查询是"锦上添花"
		// （自带 3s 预算，失败就沿用模型默认档），**不能**占用下面那次调用
		// 自己的超时预算。
		const picked = await this.pickDistillEffort(llm, model);
		const effort = picked.effort;
		// 预算阶梯：首轮用配置值（或上次成功过的更大预算），没有可见文本
		// （或输出被 max-tokens 截断）时按 4 倍递增重试，直到「空输出重试预算」
		// 这个上限。推理模型（尤其宿主没暴露推理档位的）默认档就会把预算烧在
		// 思考上，而且思考长度事先未知——一次试不出来就再来一档，找到够用的
		// 预算后由 `distillBudget` 记住，下次直接用它起步。
		const baseBudget = Math.max(128, Math.trunc(this.config.memoryDistillMaxTokens));
		const retryBudget = Math.max(0, Math.trunc(this.config.memoryDistillRetryTokens));
		const ceiling = Math.max(baseBudget, retryBudget);
		const firstBudget = Math.min(Math.max(baseBudget, this.distillBudget), ceiling);
		const ladder = buildBudgetLadder(firstBudget, ceiling);
		const baseTimeoutMs = Math.max(1000, Math.trunc(this.config.memoryDistillTimeoutMs));
		// 放大预算就要相应放宽等待时间（否则第二次只是换个方式失败）：同比例放宽，
		// 但最多到首轮超时的 4 倍、且不超过 120s（超时是用户设的预算，别无声放太宽）。
		const maxRetryTimeoutMs = Math.min(MAX_RETRY_TIMEOUT_MS, baseTimeoutMs * MAX_RETRY_TIMEOUT_FACTOR);
		const attempts: DistillAttempt[] = [];
		let raw = '';
		let usedBudget = 0;
		for (const [index, budget] of ladder.entries()) {
			const timeoutMs =
				index === 0
					? baseTimeoutMs
					: Math.min(maxRetryTimeoutMs, Math.max(baseTimeoutMs, Math.round((baseTimeoutMs * budget) / firstBudget)));
			const result = await this.callDistillModel({
				llm,
				model,
				payload,
				...(effort !== undefined ? { effort } : {}),
				budget,
				timeoutMs,
			});
			if (!result.ok) {
				this.noteFailure(
					chatKey,
					`蒸馏调用失败（模型 ${model.provider}/${model.model}${
						effort === undefined ? '' : `，推理档 ${effort}`
					}，第 ${index + 1} 次 ${budget} token，超时上限 ${timeoutMs}ms）：${result.error}`,
				);
				return false;
			}
			attempts.push(result.attempt);
			if (result.raw.trim() !== '') {
				// 有可见文本就先留着（哪怕被截断，解析失败也比没有强）。
				raw = result.raw;
				usedBudget = budget;
			}
			const truncated = result.attempt.finish === TRUNCATED_FINISH;
			if (result.raw.trim() !== '' && !truncated) break;
			const next = ladder[index + 1];
			if (next !== undefined) {
				this.trace(
					'memory-distill-retry',
					`${this.deps.labelOf(chatKey)}：第 ${index + 1} 次（${budget} token）${
						result.raw.trim() === '' ? '没有可见文本' : '输出被 max-tokens 截断'
					}，改用 ${next} token 重试`,
				);
			}
		}
		const lastSeq = allEvents[allEvents.length - 1]?.seq ?? watermark;
		if (raw.trim() === '') {
			this.rememberBudgetFloor(ceiling, attempts);
			// 空输出单独报：它不是"模型没按协议写"，而是"压根没有可见文本"，
			// 处置办法不同（调预算/换模型/换档位，而不是改提示词）。
			this.noteFailure(chatKey, this.emptyOutputReason(model, effort, picked.offered, attempts));
			return false;
		}
		// 记住"这个预算够用"：推理模型下次直接从够用的预算起步，
		// 不必每轮先白烧一次小预算（配置一改就由 reconfigure() 清掉重学）。
		this.distillBudget = usedBudget;
		const parsed = parseDistillOutput(raw, input, lastSeq);
		if (!parsed.ok) {
			const truncated = attempts[attempts.length - 1]?.finish === TRUNCATED_FINISH;
			this.rememberBudgetFloor(ceiling, attempts);
			this.noteFailure(
				chatKey,
				`蒸馏输出被丢弃（${parsed.failure.error}${
					parsed.failure.findings !== undefined ? `：${parsed.failure.findings}` : ''
				}${truncated ? '；输出被 max-tokens 截断，多半是推理吃掉了预算：调大「蒸馏输出 token 上限」/「空输出重试预算」' : ''}；${
					this.describeModelCall(model, effort)
				}，${describeAttempts(attempts)}）`,
			);
			return false;
		}
		if (parsed.outcome.ops.length === 0) {
			// 模型跑完了但认为没有值得记的：这是**成功**（水位线要推进，否则每次
			// 都重复烧同一批消息），但要在日志/命令回执里说清是"看过但没内容"，
			// 而不是"压根没跑"——两者以前长得一模一样。
			store.setWatermark(chatKey, lastSeq);
			this.lastDistillAt.set(chatKey, Date.now());
			this.failures.delete(chatKey);
			this.distillErrors.delete(chatKey);
			this.distillNotes.set(
				chatKey,
				`模型看过 ${events.length} 条新消息（覆盖到 seq ${lastSeq}），认为没有值得长期记住的内容`,
			);
			this.trace(
				'memory-distill-noop',
				`${this.deps.labelOf(chatKey)}：模型认为这 ${events.length} 条新消息没有值得记住的内容（覆盖到 seq ${lastSeq}）`,
			);
			return false;
		}
		const ops = this.config.memoryCandidateReview === true
			? parsed.outcome.ops.map((op) => (op.op === 'add' ? { ...op, status: 'pending' as const } : op))
			: parsed.outcome.ops;
		const applied = store.applyOps(chatKey, ops, lastSeq);
		if (!applied) {
			this.noteFailure(chatKey, '蒸馏结果落库失败');
			return false;
		}
		store.setWatermark(chatKey, lastSeq);
		store.enforceFactLimit(chatKey, this.config.memoryMaxFacts);
		this.lastDistillAt.set(chatKey, Date.now());
		this.unfreeze(chatKey);
		this.failures.delete(chatKey);
		this.distillErrors.delete(chatKey);
		this.distillNotes.delete(chatKey);
		this.distillRecords.set(chatKey, { at: Date.now() });
		this.logger.info(
			`dsh-qq-bot: 长期记忆已更新（${this.deps.labelOf(chatKey)}）：${parsed.outcome.ops.length} 处修改，覆盖到 seq ${lastSeq}`,
		);
		this.trace('memory-distill-ok', `${this.deps.labelOf(chatKey)}：${parsed.outcome.ops.length} 处修改，覆盖到 seq ${lastSeq}`);
		return true;
	}

	/** 最近一次蒸馏失败的原因（`/memory distill` 把它回给用户，不用去翻日志）。 */
	lastDistillError(chatKey: string): string | undefined {
		return this.distillErrors.get(chatKey);
	}

	/**
	 * 最近一次蒸馏"什么都没改"的说明（成功但零产出 / 没到阈值没调模型）。
	 *
	 * `/memory distill` 用它把「没有可蒸馏的新内容」讲清楚：是**压根没有新消息**，
	 * 还是**模型看过这批消息、认为不值得记**。没有失败原因时才有意义。
	 */
	lastDistillNote(chatKey: string): string | undefined {
		return this.distillNotes.get(chatKey);
	}

	/**
	 * 预算被吃光时抬高下次的**首轮预算**（记住失败的那一档，不超过上限）。
	 *
	 * 思考长度是模型的属性而不是会话的：既然这一档被推理吃光了，下次就没必要
	 * 从小预算重走整条阶梯。只对"预算被吃光"生效（见 `exhaustedBudget`）——
	 * 超时或调用错误跟预算无关，不该把预算顶到上限。配置一改（`reconfigure()`）
	 * 就清零重学。
	 */
	private rememberBudgetFloor(ceiling: number, attempts: DistillAttempt[]): void {
		const last = attempts[attempts.length - 1];
		if (!exhaustedBudget(last) || last === undefined) return;
		this.distillBudget = Math.min(ceiling, Math.max(this.distillBudget, last.budget));
	}

	/** 记一条"跳过/零产出"的说明（失败原因优先，不覆盖它）。 */
	private noteSkipped(chatKey: string, note: string): void {
		if (this.distillErrors.has(chatKey)) return;
		this.distillNotes.set(chatKey, note);
	}

	/** 模型 + 推理档位的可读描述（诊断用）。 */
	private describeModelCall(model: { provider: string; model: string }, effort: string | undefined): string {
		return `模型 ${model.provider}/${model.model}${effort === undefined ? '' : `，推理档 ${effort}`}`;
	}

	/**
	 * 空输出的失败原因：把每次尝试的预算、可见字数、finish 与输出 token 都摆出来，
	 * 再给出**可操作**的处置（调预算 / 换非推理模型），而不是一句"模型没输出"。
	 */
	private emptyOutputReason(
		model: { provider: string; model: string },
		effort: string | undefined,
		offered: DistillEffort['offered'],
		attempts: DistillAttempt[],
	): string {
		// 宿主没暴露推理档位 = 插件连"你少想点"都提不了，只能靠预算或换模型。
		const capability =
			offered === 'yes'
				? effort === undefined
					? '该模型声明了推理档位，但没有插件认识的档位名（无法要求它不推理）'
					: `已经在最低推理档「${effort}」`
				: offered === 'none'
					? '宿主没有为该模型暴露推理档位（插件无法要求它关闭推理）'
					: '拿不到该模型的推理档位元数据（查询失败或宿主太旧），无法要求它不推理';
		return [
			`蒸馏没有拿到任何可见文本（${this.describeModelCall(model, effort)}）：${describeAttempts(attempts)}。`,
			`${capability}。处置：把「蒸馏输出 token 上限」/「空输出重试预算」调大（上限 32768；推理模型常把整个预算烧在思考上），`,
			'或给「蒸馏模型」单独指定一个非推理模型。',
		].join('');
	}

	/**
	 * 跑**一次**蒸馏调用（自己的预算与超时）。
	 *
	 * 不抛异常：失败以 `{ ok:false, error }` 返回，由调用方决定是否继续放大预算。
	 */
	private async callDistillModel(options: {
		llm: MemoryLlmView;
		model: { provider: string; model: string };
		payload: string;
		effort?: string;
		budget: number;
		timeoutMs: number;
	}): Promise<{ ok: true; raw: string; attempt: DistillAttempt } | { ok: false; error: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs));
		let raw = '';
		let finish = '';
		let outputTokens: number | undefined;
		const kinds = new Map<string, number>();
		try {
			const stream = options.llm.stream({
				provider: options.model.provider,
				model: options.model.model,
				system: DISTILL_SYSTEM_PROMPT,
				messages: [this.deps.createUserMessage(options.payload)],
				maxTokens: options.budget,
				temperature: 0,
				...(options.effort !== undefined ? { reasoningEffort: options.effort } : {}),
				signal: controller.signal,
			});
			for await (const chunk of stream) {
				kinds.set(chunk.type, (kinds.get(chunk.type) ?? 0) + 1);
				if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text;
				if (chunk.type === 'finish') finish = finishKind(chunk.reason);
				if (chunk.type === 'usage') {
					const output = usageOutputTokens(chunk.usage);
					if (output !== undefined) outputTokens = output;
				}
			}
		} catch (error) {
			clearTimeout(timer);
			const message = controller.signal.aborted
				? `调用超时（${options.timeoutMs}ms）已中止——调大「单次蒸馏超时」（重试上限是它的 4 倍），或换更快/非推理的模型`
				: error instanceof Error
					? error.message
					: String(error);
			return { ok: false, error: message };
		}
		clearTimeout(timer);
		return {
			ok: true,
			raw,
			attempt: {
				budget: options.budget,
				chars: raw.length,
				finish,
				...(outputTokens !== undefined ? { outputTokens } : {}),
				kinds,
			},
		};
	}

	private noteFailure(chatKey: string, message: string): void {
		const count = (this.failures.get(chatKey) ?? 0) + 1;
		this.failures.set(chatKey, count);
		this.distillErrors.set(chatKey, message);
		// 失败原因优先：留着上一次的"零产出"说明只会让人以为这次也没内容。
		this.distillNotes.delete(chatKey);
		this.logger.warn(`dsh-qq-bot: ${message}（${this.deps.labelOf(chatKey)}，连续 ${count} 次）`);
		this.trace('memory-distill-failed', `${this.deps.labelOf(chatKey)}：${message}（连续 ${count} 次）`);
	}

	/** 蒸馏用模型：配置 > 部署默认。两者都拿不到时返回 undefined（跳过蒸馏）。 */
	private resolveDistillModel(): { provider: string; model: string } | undefined {
		const configuredProvider = this.config.memoryDistillProvider.trim();
		const configuredModel = this.config.memoryDistillModel.trim();
		const fallback = this.deps.getDefaultModel?.();
		const provider = configuredProvider !== '' ? configuredProvider : (fallback?.provider ?? '');
		const model = configuredModel !== '' ? configuredModel : (fallback?.model ?? '');
		if (provider === '' || model === '') return undefined;
		return { provider, model };
	}

	/** 推理档位从低到高的偏好顺序（档位 id 由各 provider 自己定义）。 */
	private static readonly EFFORT_ORDER = ['off', 'none', 'disabled', 'minimal', 'low', 'medium', 'high', 'max'];

	/**
	 * 给这次蒸馏挑一个**最低**的推理档位。
	 *
	 * 只有模型确实声明了推理档位时才显式指定（否则宿主会以
	 * `UNSUPPORTED_REASONING_EFFORT` 拒绝）；拿不到元数据、查询超时或档位名
	 * 不认识时不猜，沿用模型默认。`offered` 只用于失败诊断（区分"档位已经压到
	 * 最低还是空输出"与"宿主根本没暴露这个旋钮"）。
	 */
	private async pickDistillEffort(llm: MemoryLlmView, model: { provider: string; model: string }): Promise<DistillEffort> {
		const resolve = llm.resolveModelInfo;
		if (typeof resolve !== 'function') return { offered: 'unknown' };
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			const info = await resolve.call(llm, model.provider, model.model, controller.signal);
			const ids = (info?.reasoning?.efforts ?? [])
				.map((effort) => (typeof effort?.id === 'string' ? effort.id : ''))
				.filter((id) => id !== '');
			if (ids.length === 0) return { offered: 'none' };
			for (const wanted of MemoryService.EFFORT_ORDER) {
				const hit = ids.find((id) => id.toLowerCase() === wanted);
				if (hit !== undefined) return { effort: hit, offered: 'yes' };
			}
			return { offered: 'yes' };
		} catch {
			// 元数据查询失败不该影响蒸馏本身：沿用模型默认档。
			return { offered: 'unknown' };
		} finally {
			clearTimeout(timer);
		}
	}

	// ── 热应用 ────────────────────────────────────────────────

	/**
	 * 配置变更（WebUI 保存）后调用：清卡片缓存、必要时裁剪，并**按总开关
	 * 打开/关闭存储**（开关是热应用的；存储状态变化会通知 onStorageChange）。
	 *
	 * 打开是异步的（`node:sqlite`），所以这里不阻塞配置保存：调用方稍后拿到
	 * `onStorageChange` 再同步依赖存储的动作（如记忆工具的注册）。
	 */
	reconfigure(): void {
		this.profileCache.clear();
		// 换了模型/预算就重新学"够用的预算"，免得旧模型的档位继续生效。
		this.distillBudget = 0;
		this.store?.prune();
		void this.alignStorage().then((changed) => {
			if (changed) this.deps.onStorageChange?.();
		});
	}

	/** 记录本进程见过的 chatKey（空闲兜底扫描用）。 */
	noteChat(chatKey: string): void {
		this.seenChats.add(chatKey);
	}
}

/**
 * 把「主体 关系 内容」拆成三段。
 *
 * 顺序：先按空白切第一段（主体）与第二段（关系），剩余部分整体是内容；
 * 主体可以带空格（如 `@张三(12345)` 不含空格，但项目名可能含），所以
 * 关系词是从左往右**第一个能在白名单里命中的词**。
 */
export function splitEntry(content: string): { subject: string; predicate: string; object: string } | undefined {
	const text = content.trim();
	if (text === '') return undefined;
	// 关系词可能在任意位置：扫描空白分隔的 token，找第一个白名单词。
	const tokens: Array<{ value: string; index: number; length: number }> = [];
	const re = /\S+/g;
	let match = re.exec(text);
	while (match !== null) {
		tokens.push({ value: match[0], index: match.index, length: match[0].length });
		match = re.exec(text);
	}
	if (tokens.length < 3) return undefined;
	const predicates = ['是', '偏好', '进行中', '禁忌', '已决定', '备注'];
	let pivot = -1;
	for (let index = 1; index < tokens.length - 1; index += 1) {
		if (predicates.includes(tokens[index]!.value)) {
			pivot = index;
			break;
		}
	}
	if (pivot === -1) return undefined;
	const subject = text.slice(0, tokens[pivot]!.index).trim();
	const predicate = tokens[pivot]!.value;
	const object = text.slice(tokens[pivot]!.index + tokens[pivot]!.length).trim();
	if (subject === '' || object === '') return undefined;
	return { subject, predicate, object };
}
