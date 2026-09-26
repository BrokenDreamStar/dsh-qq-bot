/**
 * 长期记忆服务：把纯逻辑模块（card/rank/distill/handoff/guard）与 SQLite 存储、
 * 会话桥、配置串起来，并对外提供薄接口（注入面 / 采集面 / 交接面 / 蒸馏面）。
 *
 * 与 dsh 的关系：
 *  - 卡片走 `systemPrompt.section({ order: 900 })`，`text()` **每次 assembly 求值**，
 *    所以服务内部**按会话冻结**（`frozen` 缓存按 `rev` 失效只在世代切换时清），
 *    避免卡片一变就打断整段前缀缓存；
 *  - 蒸馏走 `ctx.llm.stream()` 的**一次性请求**（不建 agent、不产生会话文件、
 *    可指定便宜模型、可 abort）。`llm` 是可选服务，缺失时自动蒸馏停用，
 *    工具通道与世代交接（tail 版）照常工作。
 *
 * 失败哲学：记忆不是关键路径。所有写入/检索异常都吞掉并记日志，
 * 绝不把异常抛回 QQ 消息主链路。
 */

import type { Logger } from '../types.ts';
import { buildCapacityError, canAdd, describeUsage, renderCard, type CardUsage } from './card.ts';
import { buildDistillPayload, DISTILL_SYSTEM_PROMPT, parseDistillOutput, shouldDistill } from './distill.ts';
import { describeFindings, scanForThreats } from './guard.ts';
import { renderHandoff, shouldHandoff } from './handoff.ts';
import {
	buildMatchExpression,
	coverageOf,
	DEFAULT_PREFETCH_MIN_COVERAGE,
	FTS_CANDIDATE_LIMIT,
	normalizeBm25,
	packRecall,
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
	type MemoryStats,
	type RecallResult,
} from './types.ts';

/** 记忆服务对外暴露的配置视图（由 config.ts 的 DshQQConfig 满足）。 */
export interface MemoryConfigView {
	memoryEnabled: boolean;
	memoryCardMaxChars: number;
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
	memoryDistillTimeoutMs: number;
	memoryHandoffTail: number;
	memoryHandoffDistillWaitMs: number;
	memoryRetentionDays: number;
	memoryMaxEventsPerChat: number;
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
	}): AsyncIterable<{ type: string; text?: string }>;
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

export class MemoryService {
	private store: MemoryStore | undefined;
	/** 每个 chatKey 的卡片文本缓存（世代内冻结：非空即已冻结）。 */
	private readonly frozen = new Map<string, string>();
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
	/** 连续失败次数（退避用）。 */
	private readonly failures = new Map<string, number>();
	private idleTimer: ReturnType<typeof setInterval> | null = null;
	/** 每个 chatKey 最近一次蒸馏失败的原因（`/memory distill` 直接回给用户）。 */
	private readonly distillErrors = new Map<string, string>();

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
		const interval = this.deps.idleSweepMs ?? 0;
		if (interval <= 0) return;
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
	 * 卡片 section 文本：**会话内冻结**。
	 *
	 * 首次求值渲染并把结果缓存；之后同一会话返回同一字符串（引用相等），
	 * 卡片内容变化不会打断前缀缓存。世代切换时由 `unfreeze()` 清除。
	 */
	cardSection(chatKey: string): string {
		if (!this.ready) return '';
		const cached = this.frozen.get(chatKey);
		if (cached !== undefined) return cached;
		const facts = this.store?.facts(chatKey) ?? [];
		const text = renderCard(facts, { maxChars: this.config.memoryCardMaxChars, chatLabel: this.deps.labelOf(chatKey) }).text;
		this.frozen.set(chatKey, text);
		return text;
	}

	/** 解除冻结（世代切换 / 手动 /memory reload 时调用）。 */
	unfreeze(chatKey: string): void {
		this.frozen.delete(chatKey);
	}

	/** 能力提示 section：告诉模型记忆怎么用（工具没注册时返回空串）。 */
	guidanceSection(available: boolean): string {
		if (!this.ready || !available) return '';
		const lines = [
			`你有一份本会话的长期记忆卡片（系统提示里的「${CARD_HEADER}」块），它记录了这个会话里跨天仍然成立的事实。`,
			'需要回忆更早的对话细节时用 qq_recall_memory 检索会话档案（可以查几周前说过的话，不需要问用户）。',
			'当你了解到值得长期记住的信息（人物身份、群里的偏好与规矩、长期事项与决定、明确禁忌）时，用 qq_memorize 记下来；一次性的闲聊不要记。',
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

	/** `qq_recall_memory` 的实现。 */
	recall(chatKey: string, query: string, count?: number): RecallResult {
		const topK = Math.min(Math.max(1, Math.trunc(count ?? this.config.memoryRecallTopK)), this.config.memoryRecallTopK);
		const result = this.recallPacked(chatKey, query, { topK, maxChars: this.config.memoryRecallMaxChars });
		if (result === undefined) return { text: '（长期记忆当前不可用）', count: 0, candidates: 0 };
		if (result.match === undefined) {
			return {
				text: `${RECALL_HEADER}查询里没有可用于检索的关键词，请换用具体的词（人名、项目名、关键词）。`,
				count: 0,
				candidates: 0,
			};
		}
		const text = renderRecall(result.packed, { chatLabel: this.deps.labelOf(chatKey), query, now: result.now });
		return { text, count: result.packed.selected.length, candidates: result.candidates };
	}

	/**
	 * 每轮预取：按本轮用户文本召回，分数够高才注入（零 LLM，本地 FTS）。
	 *
	 * @returns 注入用的数据块；不需要注入时返回空串。
	 */
	prefetch(chatKey: string, query: string): string {
		if (!this.ready || !this.config.memoryPrefetch) return '';
		const result = this.recallPacked(chatKey, query, {
			topK: this.config.memoryPrefetchMaxItems,
			maxChars: Math.min(this.config.memoryRecallMaxChars, 900),
		});
		if (result === undefined || result.match === undefined) return '';
		if (!shouldPrefetch(result.packed, this.config.memoryPrefetchMinScore, { minCoverage: DEFAULT_PREFETCH_MIN_COVERAGE })) return '';
		return renderRecall(result.packed, { chatLabel: this.deps.labelOf(chatKey), query, now: result.now });
	}

	// ── 写入面（工具） ─────────────────────────────────────────

	/** `qq_memorize` 的实现（容量满时报错并带回当前条目）。 */
	memorize(input: {
		chatKey: string;
		action: 'add' | 'replace' | 'remove';
		content?: string;
		oldText?: string;
	}): { ok: true; text: string } | { ok: false; error: string; usage?: CardUsage } {
		const store = this.store;
		if (!this.ready || store === undefined) return { ok: false, error: '长期记忆当前不可用（未启用或存储不可用）' };
		const facts = store.facts(input.chatKey);
		const usage = describeUsage(facts, this.config.memoryCardMaxChars);

		if (input.action === 'add') {
			const content = input.content?.trim() ?? '';
			if (content === '') return { ok: false, error: 'add 需要 content（要记住的内容）' };
			const verdict = scanForThreats(content);
			if (!verdict.ok) return { ok: false, error: `内容命中安全扫描（${describeFindings(verdict.findings)}），已拒绝写入` };
			if (!canAdd(facts, this.config.memoryCardMaxChars, content)) {
				if (this.tooManyWriteFailures(input.chatKey)) {
					return { ok: false, error: '本轮整理记忆的尝试次数已用完，请先继续对话，下一轮再整理。', usage };
				}
				return { ok: false, error: buildCapacityError(usage, content.length), usage };
			}
			const parsed = splitEntry(content);
			if (parsed === undefined) {
				return { ok: false, error: 'content 需要是「主体 关系 内容」的形式，例如「@张三(12345) 是 运维」。', usage };
			}
			const added = store.addFact({ chatKey: input.chatKey, subject: parsed.subject, predicate: parsed.predicate, object: parsed.object });
			if ('error' in added) return { ok: false, error: added.error, usage };
			store.enforceFactLimit(input.chatKey, this.config.memoryMaxFacts);
			return { ok: true, text: `已记住（${describeUsage(store.facts(input.chatKey), this.config.memoryCardMaxChars).label} 字）。注意：这张卡片在本会话的系统提示里是快照，新条目从下一段会话（/reset 或轮换）开始生效；当前会话你可以直接按它回答。` };
		}

		const oldText = input.oldText?.trim() ?? '';
		if (oldText === '') return { ok: false, error: `${input.action} 需要 old_text（能唯一定位条目的短子串）` };
		const matches = facts.filter(
			(fact) =>
				fact.supersededBy === null &&
				(fact.object.includes(oldText) || fact.subject.includes(oldText) || `${fact.subject} ${fact.predicate} ${fact.object}`.includes(oldText)),
		);
		if (matches.length === 0) {
			return { ok: false, error: `没有条目包含「${oldText}」。当前条目见 usage.current_entries。`, usage };
		}
		if (matches.length > 1) {
			return { ok: false, error: `「${oldText}」匹配到 ${matches.length} 条，请换更具体的子串。当前条目见 usage.current_entries。`, usage };
		}
		const target = matches[0]!;
		if (input.action === 'remove') {
			if (!store.supersedeFact(input.chatKey, target.id)) return { ok: false, error: '删除失败（详见日志）', usage };
			return { ok: true, text: `已删除：「${target.object}」（当前 ${describeUsage(store.facts(input.chatKey), this.config.memoryCardMaxChars).label} 字）。` };
		}
		const content = input.content?.trim() ?? '';
		if (content === '') return { ok: false, error: 'replace 需要 content（改写后的内容）' };
		const parsed = splitEntry(content);
		if (parsed === undefined) return { ok: false, error: 'content 需要是「主体 关系 内容」的形式。', usage };
		const updated = store.addFact({
			chatKey: input.chatKey,
			subject: parsed.subject,
			predicate: parsed.predicate,
			object: parsed.object,
		});
		if ('error' in updated) return { ok: false, error: updated.error, usage };
		if (updated.id !== target.id) {
			// 主体/关系变了：旧条目留着会重复，直接取代掉。
			store.supersedeFact(input.chatKey, target.id, updated.id);
		}
		return { ok: true, text: `已更新为：「${parsed.object}」（当前 ${describeUsage(store.facts(input.chatKey), this.config.memoryCardMaxChars).label} 字）。` };
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
	 * 幂等：内部按 `session:<chatKey>` 记录已交接过的 sessionId，
	 * 同一个世代只会拿到一次交接（rotate/reset/重启三条路径共用）。
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
	 * 世代结束（rotate / reset 前）调用：尽力把这一段对话蒸馏掉，再写交接锚点。
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
			if (this.shouldDistillNow(chatKey)) void this.distill(chatKey, { force: false });
		}, 50).unref?.();
	}

	/** 是否满足批量阈值（供 record 里的即时判断）。 */
	private shouldDistillNow(chatKey: string): boolean {
		const store = this.store;
		if (store === undefined || !this.config.memoryEnabled) return false;
		if (this.deps.getLlm?.() === undefined) return false;
		if (this.inflight.has(chatKey)) return false;
		const last = this.lastAttempt.get(chatKey) ?? 0;
		const failures = this.failures.get(chatKey) ?? 0;
		// 失败退避：连续失败后 10 分钟内不再自动尝试。
		if (failures > 0 && Date.now() - last < 600_000) return false;
		const watermark = store.watermark(chatKey);
		const events = store.eventsAfter(chatKey, watermark, 200);
		if (events.length === 0) return false;
		const chars = events.reduce((total, event) => total + event.text.length, 0);
		return shouldDistill({
			newEvents: events.length,
			newChars: chars,
			minEvents: this.config.memoryDistillEvery,
			minChars: this.config.memoryDistillMinChars,
		});
	}

	/** 空闲兜底扫描：对所有有未蒸馏事件的会话尝试一次。 */
	private async sweepIdle(): Promise<void> {
		const store = this.store;
		if (store === undefined || !this.ready) return;
		for (const chatKey of this.knownChats()) {
			if (this.shouldDistillNow(chatKey)) await this.distill(chatKey, { force: false });
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
		const events = store.eventsAfter(chatKey, watermark, 500);
		if (!shouldDistill({
			newEvents: events.length,
			newChars: events.reduce((total, event) => total + event.text.length, 0),
			minEvents: this.config.memoryDistillEvery,
			minChars: this.config.memoryDistillMinChars,
			force: options.force === true,
		})) {
			return false;
		}
		this.lastAttempt.set(chatKey, Date.now());
		const model = this.resolveDistillModel();
		if (model === undefined) {
			this.noteFailure(chatKey, '没有可用的模型：部署默认模型与 memoryDistillProvider/Model 都为空');
			return false;
		}
		const facts = store.facts(chatKey).filter((fact) => fact.supersededBy === null);
		const input = {
			chatKey,
			chatLabel: this.deps.labelOf(chatKey),
			existing: facts,
			events,
			limits: { maxNewFacts: 5, objectMaxChars: 80 },
		};
		const payload = buildDistillPayload(input);
		// 推理档位：机械抽取不需要长推理。有的模型默认档会把整个 token 预算
		// 烧在 reasoning 上、可见文本一个字都不吐（表现为 JSON 解析失败）。
		// 元数据查询是"锦上添花"（自带 3s 预算，失败就沿用模型默认档），
		// **不能**占用下面那次调用自己的超时预算。
		const effort = await this.pickDistillEffort(llm, model);
		const controller = new AbortController();
		const timeoutMs = Math.max(1000, Math.trunc(this.config.memoryDistillTimeoutMs));
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let raw = '';
		const chunkKinds = new Map<string, number>();
		const describeCall = (): string =>
			`模型 ${model.provider}/${model.model}，预算 ${this.config.memoryDistillMaxTokens} token${
				effort === undefined ? '' : `，推理档 ${effort}`
			}，收到 ${raw.length} 字${
				chunkKinds.size === 0 ? '' : `（${[...chunkKinds].map(([kind, count]) => `${kind}×${count}`).join(' ')}）`
			}`;
		try {
			const stream = llm.stream({
				provider: model.provider,
				model: model.model,
				system: DISTILL_SYSTEM_PROMPT,
				messages: [this.deps.createUserMessage(payload)],
				maxTokens: this.config.memoryDistillMaxTokens,
				temperature: 0,
				...(effort !== undefined ? { reasoningEffort: effort } : {}),
				signal: controller.signal,
			});
			for await (const chunk of stream) {
				chunkKinds.set(chunk.type, (chunkKinds.get(chunk.type) ?? 0) + 1);
				if (chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text;
			}
		} catch (error) {
			clearTimeout(timer);
			this.noteFailure(chatKey, `蒸馏调用失败：${error instanceof Error ? error.message : String(error)}（${describeCall()}）`);
			return false;
		}
		clearTimeout(timer);
		const lastSeq = events[events.length - 1]?.seq ?? watermark;
		if (raw.trim() === '') {
			// 空输出单独报：它不是"模型没按协议写"，而是"压根没有可见文本"，
			// 处置办法不同（调预算/换模型/换档位，而不是改提示词）。
			this.noteFailure(
				chatKey,
				`蒸馏没有拿到任何可见文本（${describeCall()}）——多半是推理吃掉了全部预算：调大「蒸馏最大 token」或给蒸馏单独指定一个非推理模型`,
			);
			return false;
		}
		const parsed = parseDistillOutput(raw, input, lastSeq);
		if (!parsed.ok) {
			this.noteFailure(
				chatKey,
				`蒸馏输出被丢弃（${parsed.failure.error}${parsed.failure.findings !== undefined ? `：${parsed.failure.findings}` : ''}；${describeCall()}）`,
			);
			return false;
		}
		if (parsed.outcome.ops.length === 0) {
			store.setWatermark(chatKey, lastSeq);
			this.failures.delete(chatKey);
			this.distillErrors.delete(chatKey);
			return false;
		}
		const applied = store.applyOps(chatKey, parsed.outcome.ops, lastSeq);
		if (!applied) {
			this.noteFailure(chatKey, '蒸馏结果落库失败');
			return false;
		}
		store.setWatermark(chatKey, lastSeq);
		store.enforceFactLimit(chatKey, this.config.memoryMaxFacts);
		this.failures.delete(chatKey);
		this.distillErrors.delete(chatKey);
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

	private noteFailure(chatKey: string, message: string): void {
		const count = (this.failures.get(chatKey) ?? 0) + 1;
		this.failures.set(chatKey, count);
		this.distillErrors.set(chatKey, message);
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
	 * 不认识时不猜，沿用模型默认。
	 */
	private async pickDistillEffort(llm: MemoryLlmView, model: { provider: string; model: string }): Promise<string | undefined> {
		const resolve = llm.resolveModelInfo;
		if (typeof resolve !== 'function') return undefined;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			const info = await resolve.call(llm, model.provider, model.model, controller.signal);
			const ids = (info?.reasoning?.efforts ?? [])
				.map((effort) => (typeof effort?.id === 'string' ? effort.id : ''))
				.filter((id) => id !== '');
			if (ids.length === 0) return undefined;
			for (const wanted of MemoryService.EFFORT_ORDER) {
				const hit = ids.find((id) => id.toLowerCase() === wanted);
				if (hit !== undefined) return hit;
			}
			return undefined;
		} catch {
			// 元数据查询失败不该影响蒸馏本身：沿用模型默认档。
			return undefined;
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
		this.frozen.clear();
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
