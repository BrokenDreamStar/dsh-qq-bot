/**
 * 搜索优先级链（纯逻辑，可单测）：按配置顺序依次尝试后端，**前一个失败或
 * 没有结果时顺延到下一个**（用户要的语义：配 1.exa 2.tavily 3.dsh，则先
 * 用 exa，失败再用 tavily，最后用 dsh 内置）。
 *
 * 一轮 = 一个后端 + 所有还没有结果的查询（并发）。已经拿到结果的查询不会
 * 再打后面的后端，所以多查询调用不会把整条链重复跑一遍。每条查询的每一次
 * 尝试（成功/空结果/失败/跳过）都记进 attempts，供消息日志与错误消息使用。
 *
 * 三种态的意义：
 *  - failed   网络/HTTP/解析失败（或超过超时）→ 顺延
 *  - skipped  这个后端不可用（缺 API Key / 宿主没有 ctx.web）→ 顺延
 *  - empty    后端正常应答但没有任何来源与摘要 → 顺延，同时记下它作为兜底
 *             （全部后端都空时返回"确实没有结果"，而不是报错）
 */
import { SEARCH_BACKEND_LABELS, type SearchBackend, type SearchOutcome, type SearchSource } from './providers.ts';

/** 一次后端尝试的结果态。 */
export type ChainAttemptStatus = 'ok' | 'empty' | 'failed' | 'skipped';

/** 一次后端尝试（记进日志/错误消息）。 */
export interface ChainAttempt {
	backend: SearchBackend;
	/** 这次尝试针对的查询。 */
	query: string;
	status: ChainAttemptStatus;
	/** 失败原因 / 跳过原因（ok 时为空）。 */
	detail?: string;
	/** ok/empty 时：这次返回的来源条数。 */
	sources?: number;
}

/** 搜索链的最终结果（工具输出据此渲染）。 */
export interface SearchChainResult {
	content?: string;
	sources: SearchSource[];
	truncated: boolean;
	/** 实际产出结果的后端（按链序去重；全部为空时是"答了但没结果"的后端）。 */
	backends: SearchBackend[];
	/** 没有任何结果的查询（该查询在所有后端上都失败/跳过，或都返回空）。 */
	unanswered: string[];
	attempts: ChainAttempt[];
}

export interface SearchChainOptions {
	entries: readonly SearchBackend[];
	queries: readonly string[];
	/** 结果条数上限（跨后端、跨查询合并后的上限）。 */
	maxResults: number;
	/** 单个后端对单条查询的执行体（真实网络或 ctx.web；由 service 注入）。 */
	run(backend: SearchBackend, query: string, signal?: AbortSignal): Promise<SearchOutcome>;
	/** 后端不可用时的原因（返回 undefined = 可用）。 */
	unavailable(backend: SearchBackend): string | undefined;
	signal?: AbortSignal;
	/** 每次尝试的即时回调（service 用它记日志）。 */
	onAttempt?(attempt: ChainAttempt): void;
}

/** 全链路失败（连"空结果"都没有）：错误消息已含每个后端的原因。 */
export class SearchChainError extends Error {
	constructor(
		message: string,
		readonly attempts: readonly ChainAttempt[],
	) {
		super(message);
		this.name = 'SearchChainError';
	}
}

export async function runSearchChain(options: SearchChainOptions): Promise<SearchChainResult> {
	const attempts: ChainAttempt[] = [];
	const note = (attempt: ChainAttempt): void => {
		attempts.push(attempt);
		options.onAttempt?.(attempt);
	};
	/** 查询 → 有内容的结果（最终采用）。 */
	const answers = new Map<string, { backend: SearchBackend; outcome: SearchOutcome }>();
	/** 查询 → 空结果（所有后端都没内容时的兜底，避免把"确实没有"报成失败）。 */
	const empties = new Map<string, { backend: SearchBackend; outcome: SearchOutcome }>();
	const backends: SearchBackend[] = [];

	for (const backend of options.entries) {
		const pending = options.queries.filter((query) => !answers.has(query));
		if (pending.length === 0) break;
		throwIfAborted(options.signal);
		const skip = options.unavailable(backend);
		if (skip !== undefined) {
			for (const query of pending) note({ backend, query, status: 'skipped', detail: skip });
			continue;
		}
		const settled = await Promise.allSettled(pending.map((query) => options.run(backend, query, options.signal)));
		settled.forEach((entry, index) => {
			const query = pending[index] ?? '';
			if (entry.status === 'rejected') {
				note({ backend, query, status: 'failed', detail: messageOf(entry.reason) });
				return;
			}
			const outcome = entry.value;
			if (isEmptyOutcome(outcome)) {
				note({ backend, query, status: 'empty', sources: 0 });
				if (!empties.has(query)) empties.set(query, { backend, outcome });
				return;
			}
			note({ backend, query, status: 'ok', sources: outcome.sources.length });
			answers.set(query, { backend, outcome });
			if (!backends.includes(backend)) backends.push(backend);
		});
		// 调用方取消（工具超时 / 用户打断）后不再尝试下一个后端。
		throwIfAborted(options.signal);
	}

	const answered = options.queries.filter((query) => answers.has(query));
	if (answered.length === 0) {
		const emptyQueries = options.queries.filter((query) => empties.has(query));
		if (emptyQueries.length === 0) {
			throw new SearchChainError(`dsh-qq-bot: 网页搜索失败——${summarizeAttempts(attempts)}`, attempts);
		}
		// 全部查询都"成功了但没有结果"：这是有效结果（模型该告诉用户确实没搜到）。
		return {
			sources: [],
			truncated: false,
			backends: uniqueBackends(emptyQueries.map((query) => empties.get(query)?.backend)),
			unanswered: options.queries.filter((query) => !empties.has(query)),
			attempts,
		};
	}

	const picked = answered.map((query) => ({ query, outcome: answers.get(query)!.outcome }));
	return {
		...mergeOutcomes(picked, options.maxResults),
		backends,
		unanswered: options.queries.filter((query) => !answers.has(query)),
		attempts,
	};
}

/** 把多个查询的结果合并：来源按轮转顺序去重后截到 maxResults，摘要按查询分段。 */
function mergeOutcomes(picked: readonly { query: string; outcome: SearchOutcome }[], maxResults: number): Pick<SearchChainResult, 'content' | 'sources' | 'truncated'> {
	const seen = new Set<string>();
	const sources: SearchSource[] = [];
	let ranks = 0;
	for (const entry of picked) ranks = Math.max(ranks, entry.outcome.sources.length);
	let dropped = false;
	merge: for (let rank = 0; rank < ranks; rank += 1) {
		for (const entry of picked) {
			const source = entry.outcome.sources[rank];
			if (source === undefined || seen.has(source.url)) continue;
			seen.add(source.url);
			if (sources.length >= maxResults) {
				dropped = true;
				break merge;
			}
			sources.push(source);
		}
	}
	const contents = picked.flatMap((entry) =>
		entry.outcome.content !== undefined && entry.outcome.content !== ''
			? [picked.length > 1 ? `### ${entry.query}\n\n${entry.outcome.content}` : entry.outcome.content]
			: [],
	);
	return {
		...(contents.length > 0 ? { content: contents.join('\n\n') } : {}),
		sources,
		truncated: picked.some((entry) => entry.outcome.truncated) || dropped,
	};
}

/** 每个后端取第一条非 ok 的原因，拼成"哪儿出了问题"的一句话。 */
export function summarizeAttempts(attempts: readonly ChainAttempt[]): string {
	const reasons = new Map<SearchBackend, string>();
	for (const attempt of attempts) {
		if (attempt.status === 'ok' || reasons.has(attempt.backend)) continue;
		reasons.set(attempt.backend, attempt.detail ?? (attempt.status === 'empty' ? '没有结果' : attempt.status));
	}
	if (reasons.size === 0) return '没有可用的搜索后端（请检查「搜索优先级」与 API Key 配置）';
	return [...reasons].map(([backend, detail]) => `${SEARCH_BACKEND_LABELS[backend]}（${detail}）`).join('、');
}

function isEmptyOutcome(outcome: SearchOutcome): boolean {
	return outcome.sources.length === 0 && (outcome.content === undefined || outcome.content === '');
}

function uniqueBackends(list: readonly (SearchBackend | undefined)[]): SearchBackend[] {
	const out: SearchBackend[] = [];
	for (const backend of list) {
		if (backend !== undefined && !out.includes(backend)) out.push(backend);
	}
	return out;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted !== true) return;
	throw signal.reason instanceof Error ? signal.reason : new Error('dsh-qq-bot: 网页搜索已取消');
}

function messageOf(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}
