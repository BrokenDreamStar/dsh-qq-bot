import { describe, expect, it } from 'vitest';
import { coverageOf, finalScore, normalizeScores, recencyScore, rrfFuse } from './fusion.ts';

describe('fusion：混合召回', () => {
	it('RRF 只依赖名次，两个列表都能贡献', () => {
		const scores = rrfFuse([[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]]);
		expect(scores.get(2)).toBeGreaterThan(scores.get(1)!);
		expect(scores.get(2)).toBeGreaterThan(scores.get(3)!);
	});

	it('归一化到 0~1', () => {
		const normalized = normalizeScores(new Map([[1, 2], [2, 4]]));
		expect(normalized.get(1)).toBe(0.5);
		expect(normalized.get(2)).toBe(1);
	});

	it('时间衰减：越久越低，未来按 1', () => {
		const now = Date.now();
		const recent = recencyScore(now, now, 30);
		const old = recencyScore(now - 30 * 86_400_000, now, 30);
		expect(recent).toBeCloseTo(1, 3);
		expect(old).toBeCloseTo(Math.exp(-1), 3);
		expect(recencyScore(now + 1000, now, 30)).toBe(1);
	});

	it('词元覆盖率', () => {
		expect(coverageOf(['备份', 'restic'], '我在说备份方案')).toBe(0.5);
		expect(coverageOf([], 'x')).toBe(0);
	});

	it('融合分：有重排时重排权重更高', () => {
		const without = finalScore({ rrf: 0.5, recency: 0.5, coverage: 0.5 });
		const withRerank = finalScore({ rrf: 0.5, recency: 0.5, coverage: 0.5, rerank: 1 });
		expect(withRerank).toBeGreaterThan(without);
		expect(withRerank).toBeLessThanOrEqual(1);
	});
});
