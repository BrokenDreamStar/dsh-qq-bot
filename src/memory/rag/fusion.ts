/**
 * 混合召回融合（纯逻辑，可测）。
 *
 * FTS 的 bm25 与向量的 cosine distance 量纲完全不同，不能直接相加；
 * 这里用 RRF（Reciprocal Rank Fusion）只依赖名次，再做时间衰减与词元覆盖率加权。
 * 重排开启时，用重排分替换 RRF 的主权重。
 */

export interface RankedId {
	id: number;
}

/** Reciprocal Rank Fusion：`Σ 1/(k + rank)`，rank 从 1 开始。 */
export function rrfFuse(lists: ReadonlyArray<ReadonlyArray<RankedId>>, k = 60): Map<number, number> {
	const scores = new Map<number, number>();
	for (const list of lists) {
		for (let index = 0; index < list.length; index += 1) {
			const id = list[index]!.id;
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
		}
	}
	return scores;
}

/** 按本批最大值归一化到 0~1；空/全零返回空 Map。 */
export function normalizeScores(scores: ReadonlyMap<number, number>): Map<number, number> {
	let max = 0;
	for (const value of scores.values()) if (value > max) max = value;
	const normalized = new Map<number, number>();
	if (max <= 0) return normalized;
	for (const [id, value] of scores) normalized.set(id, value / max);
	return normalized;
}

/** 时间衰减：`exp(-ageDays / halfLifeDays)`；未来时间按 1 处理。 */
export function recencyScore(ts: number, now: number, halfLifeDays: number): number {
	if (!Number.isFinite(ts) || ts <= 0) return 0;
	const ageDays = Math.max(0, (now - ts) / 86_400_000);
	const halfLife = Math.max(1, halfLifeDays);
	return Math.exp(-ageDays / halfLife);
}

/** 查询词元覆盖率：查询词有多少比例出现在文本里。 */
export function coverageOf(tokens: readonly string[], text: string): number {
	if (tokens.length === 0) return 0;
	const lower = text.toLowerCase();
	let hit = 0;
	for (const token of tokens) {
		if (token !== '' && lower.includes(token.toLowerCase())) hit += 1;
	}
	return hit / tokens.length;
}

/** 最终融合分（0~1）。 */
export function finalScore(input: {
	rrf: number;
	recency: number;
	coverage: number;
	rerank?: number;
}): number {
	const rrf = clamp01(input.rrf);
	const recency = clamp01(input.recency);
	const coverage = clamp01(input.coverage);
	if (input.rerank !== undefined) {
		return clamp01(0.7 * clamp01(input.rerank) + 0.2 * rrf + 0.1 * recency);
	}
	return clamp01(0.6 * rrf + 0.25 * recency + 0.15 * coverage);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}
