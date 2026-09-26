/**
 * L1 检索的打分与打包（纯逻辑，可测）。不碰数据库 —— SQLite 只负责给出
 * BM25 原始分与候选行，排序/衰减/去重/预算都在这里做，便于单测覆盖。
 *
 * 打分（docs/memory-design.md §6.3）：
 *   score = 0.6·bm25Norm + 0.3·0.5^(ageDays/halfLife) + 0.1·min(1, log1p(hits)/2)
 * 其中 `bm25Norm = c/(c+|bm25|)`，`c = 3`（SQLite 的 bm25() 返回负数，越小越相关）。
 * 记忆场景关心「最近说过的、相关的」，所以时间衰减权重不低。
 */

import { sanitizeMemoryText } from './guard.ts';
import { formatEntryTime } from '../onebot/history.ts';
import { MAX_EVENT_CHARS, RECALL_HEADER, MEMORY_SAFETY_NOTE, type MemoryEvent, type RecallCandidate } from './types.ts';

/**
 * 打分权重（和为 1）。
 *
 * **BM25 采用"相对归一"**：SQLite 的 `bm25()` 原始分只有 ~1e-6 量级（受文档数、
 * 词频与列数影响），拿它做 `x/(x+c)` 的绝对归一会被常数淹没，等于丢掉关键词相关度。
 * 所以这里先把同一批候选的 |bm25| 除以该批最大值（`normalizeBm25`），再参与打分 ——
 * 排序因此只看**相对相关度**，与库大小无关，也便于测试。
 */
export const WEIGHT_BM25 = 0.7;
export const WEIGHT_RECENCY = 0.3;
/** FTS 单次扫描的候选行上限（超出按 BM25 取最好的一批再算综合分）。 */
export const FTS_CANDIDATE_LIMIT = 200;
/** 预取门槛：查询词元在命中文本里的覆盖率下限（防止"只有一个字沾边"就注入）。 */
export const DEFAULT_PREFETCH_MIN_COVERAGE = 0.25;

/**
 * 把用户查询切成 FTS5 可安全使用的词元。
 *
 * 保留 ASCII 字母数字词（小写化）、**单位数字**（版本号/数量是有效检索词）与
 * **单个 CJK 字符**（SQLite 的 unicode61 分词器把连续汉字拆成单字，所以查询侧
 * 也按单字切，靠 BM25 排序区分相关度）。同时去掉 FTS5 语法字符（`"` `*` `(`
 * `)` `:` `^` `-` `NEAR` 等）——用户输入直接进 MATCH 会语法错误，必须清洗。
 */
export function tokenizeQuery(query: string): string[] {
	const cleaned = sanitizeMemoryText(query).toLowerCase();
	const tokens: string[] = [];
	const re = /[a-z0-9_]{2,}|[0-9]|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
	let match = re.exec(cleaned);
	while (match !== null) {
		tokens.push(match[0]);
		match = re.exec(cleaned);
	}
	// 去重但保留顺序；限制词元数，避免超长查询把 MATCH 表达式撑爆。
	return [...new Set(tokens)].slice(0, 24);
}

/**
 * 构造 FTS5 MATCH 表达式：每个词元用双引号包成短语、词间 OR（宽松召回）。
 *
 * OR 而不是 AND 是刻意的：群聊记忆的查询多是「谁/什么/上次」这类短问句，
 * AND 会把「张三说的备份方案」这种多词查询命中率压到接近 0，而相关度由
 * BM25 + 时间衰减排序兜底。返回 undefined = 查询里没有可用词元。
 */
export function buildMatchExpression(query: string): string | undefined {
	const tokens = tokenizeQuery(query);
	if (tokens.length === 0) return undefined;
	return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

/** 把一批候选的 |bm25| 归一到 0~1（除以该批最大值）。空批返回空数组。 */
export function normalizeBm25(candidates: readonly { bm25: number }[]): number[] {
	const magnitudes = candidates.map((candidate) => Math.abs(candidate.bm25));
	const max = magnitudes.reduce((best, value) => (value > best ? value : best), 0);
	if (max <= 0) return candidates.map(() => 0);
	return magnitudes.map((value) => value / max);
}

/**
 * 查询词元在文本里的覆盖率（0~1）：命中多少个不同的查询词元。
 *
 * 预取门槛用它而不是绝对 BM25 —— FTS 只保证"至少命中一个词元"，
 * 只沾一个字就注入会带来大量噪声；覆盖率是确定性的、与库大小无关的信号。
 */
export function coverageOf(tokens: readonly string[], text: string): number {
	if (tokens.length === 0) return 0;
	const haystack = text.toLowerCase();
	let hit = 0;
	for (const token of tokens) {
		if (haystack.includes(token)) hit += 1;
	}
	return Math.min(1, hit / tokens.length);
}

/**
 * 综合打分。
 *
 * @param bm25Norm - `normalizeBm25()` 归一后的关键词相关度（0~1）。
 * @param ts - 事件时间（epoch ms）。
 * @param now - 当前时间（可注入，便于测试）。
 * @param coverage - 查询词元覆盖率（0~1，见 `coverageOf`）。
 * @param halfLifeDays - 时间衰减半衰期（天）。
 */
export function scoreCandidate(options: {
	bm25Norm: number;
	ts: number;
	now?: number;
	coverage?: number;
	halfLifeDays: number;
}): number {
	const now = options.now ?? Date.now();
	const bm25Norm = Math.min(1, Math.max(0, options.bm25Norm));
	const ageDays = Math.max(0, (now - options.ts) / 86_400_000);
	const halfLife = Math.max(0.5, options.halfLifeDays);
	const recency = Math.pow(0.5, ageDays / halfLife);
	// 覆盖率作为关键词项的乘子：一个词都没覆盖（不该发生）时只剩时间分。
	const coverage = options.coverage === undefined ? 1 : Math.min(1, Math.max(0, options.coverage));
	return WEIGHT_BM25 * bm25Norm * coverage + WEIGHT_RECENCY * recency;
}

/** 按综合分从高到低排序（同分按时间新的在前，再按 seq 稳定）。 */
export function rankCandidates(candidates: readonly RecallCandidate[]): RecallCandidate[] {
	return [...candidates].sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.event.ts !== a.event.ts) return b.event.ts - a.event.ts;
		return (b.event.seq ?? 0) - (a.event.seq ?? 0);
	});
}

/** 打包结果。 */
export interface PackedRecall {
	/** 选中的候选（已排序、已去重、已按预算裁剪）。 */
	selected: RecallCandidate[];
	/** 因为条数或预算被丢掉的候选数。 */
	dropped: number;
}

/**
 * 去重 + 按分数取前 topK + 按字符预算累加（**整条取舍，不截断句子**）。
 *
 * 去重键：有 messageId 用 id，否则用 `发送者|秒|文本前缀`（同一句话被本地缓冲与
 * 远端历史各记一次时不会重复占预算）；**保留分数最高的一条**（分数是排序主键）。
 */
export function packRecall(
	candidates: readonly RecallCandidate[],
	options: { topK: number; maxChars: number; now?: number },
): PackedRecall {
	const now = options.now ?? Date.now();
	const byKey = new Map<string, RecallCandidate>();
	const ordered: RecallCandidate[] = [];
	for (const candidate of rankCandidates(candidates)) {
		const key = dedupeKey(candidate.event);
		const existing = byKey.get(key);
		if (existing === undefined) {
			byKey.set(key, candidate);
			ordered.push(candidate);
			continue;
		}
		// 同一句话出现多次：保留分数最高的那条（rankCandidates 已降序，正常情况下不会走到）。
		if (candidate.score > existing.score) {
			byKey.set(key, candidate);
			ordered[ordered.indexOf(existing)] = candidate;
		}
	}
	const topK = Math.max(1, Math.trunc(options.topK));
	const maxChars = Math.max(64, Math.trunc(options.maxChars));
	const selected: RecallCandidate[] = [];
	let used = 0;
	for (const candidate of ordered) {
		if (selected.length >= topK) break;
		const cost = renderEventLine(candidate.event, now).length + 1;
		if (selected.length > 0 && used + cost > maxChars) break;
		selected.push(candidate);
		used += cost;
	}
	return { selected, dropped: ordered.length - selected.length };
}

function dedupeKey(event: MemoryEvent): string {
	if (event.msgId !== undefined && event.msgId !== '') return `id:${event.msgId}`;
	return `t:${event.senderId}|${Math.floor(event.ts / 1000)}|${event.text.slice(0, 32)}`;
}

/**
 * 单条档案行的渲染（时间 + 昵称 + 文本；机器人自己标【你】）。
 * **不渲染 QQ 号**：号码出现在模型可见文本里就会被写进回复
 * （用户明确要求机器人不要输出别人的 QQ 号）。
 */
export function renderEventLine(event: MemoryEvent, now: number = Date.now()): string {
	const who = event.senderName !== '' ? event.senderName : event.senderId;
	const text = truncate(sanitizeMemoryText(event.text), MAX_EVENT_CHARS);
	return `[${formatEntryTime(event.ts, now)}] ${who}${event.self ? '【你】' : ''}：${text}`;
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

/**
 * 把打包结果渲染成给模型看的档案文本。
 *
 * @returns 渲染文本；无命中时返回一句明确的「没找到」文案（而不是空串，
 *   空串会让模型以为自己没调用成功）。
 */
export function renderRecall(
	packed: PackedRecall,
	options: { chatLabel: string; query: string; now?: number },
): string {
	const now = options.now ?? Date.now();
	if (packed.selected.length === 0) {
		return `${RECALL_HEADER}在${options.chatLabel}的会话档案里没有找到与「${sanitizeMemoryText(options.query)}」相关的记录。可以换个说法再查，或直接问用户。`;
	}
	const lines = packed.selected.map((candidate) => renderEventLine(candidate.event, now));
	const more = packed.dropped > 0 ? `\n（另有 ${packed.dropped} 条相关记录未展开）` : '';
	return (
		`${RECALL_HEADER}${options.chatLabel}中与「${sanitizeMemoryText(options.query)}」相关的 ${lines.length} 条记录` +
		`（时间正序；【你】= 机器人自己说的）：\n${lines.join('\n')}${more}\n${MEMORY_SAFETY_NOTE}`
	);
}

/**
 * 预取阈值判断：分数够高**且**覆盖率够高才注入。
 *
 * 覆盖率这一关是必要的：FTS 的 OR 查询只要沾一个词元就命中，只看分数会让
 * 「一个字相同」的闲聊被注入每一轮上下文。
 *
 * @param minItems - 至少几条才值得注入（默认 1：一条高覆盖的命中也有价值，
 *   调用方可以要求 2 条来进一步降低噪声）。
 */
export function shouldPrefetch(
	packed: PackedRecall,
	minScore: number,
	options: { minCoverage?: number; minItems?: number } = {},
): boolean {
	const best = packed.selected[0];
	if (best === undefined) return false;
	if (best.score < minScore) return false;
	const minCoverage = options.minCoverage ?? DEFAULT_PREFETCH_MIN_COVERAGE;
	if (best.coverage !== undefined && best.coverage < minCoverage) return false;
	return packed.selected.length >= Math.max(1, Math.trunc(options.minItems ?? 1));
}
