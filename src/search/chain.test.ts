import { describe, expect, it } from 'vitest';
import { SearchChainError, runSearchChain, summarizeAttempts, type ChainAttempt, type SearchChainOptions } from './chain.ts';
import type { SearchBackend, SearchOutcome } from './providers.ts';

function outcome(urls: string[], content?: string): SearchOutcome {
	return {
		...(content !== undefined ? { content } : {}),
		sources: urls.map((url) => ({ url })),
		truncated: false,
	};
}

/** 造一个可控的链：`results` 里是 per-backend 行为（值 = 该后端的响应/错误）。 */
function options(
	entries: SearchBackend[],
	behavior: Partial<Record<SearchBackend, (query: string) => Promise<SearchOutcome>>>,
	overrides: Partial<SearchChainOptions> = {},
): SearchChainOptions {
	return {
		entries,
		queries: ['q1'],
		maxResults: 8,
		unavailable: () => undefined,
		run: (backend, query) => {
			const handler = behavior[backend];
			if (handler === undefined) throw new Error(`没有为 ${backend} 准备行为`);
			return handler(query);
		},
		...overrides,
	};
}

describe('runSearchChain', () => {
	it('第一档成功时不再打后面的后端', async () => {
		const calls: SearchBackend[] = [];
		const result = await runSearchChain(
			options(['exa', 'tavily'], {
				exa: async () => {
					calls.push('exa');
					return outcome(['https://a.test']);
				},
				tavily: async () => {
					calls.push('tavily');
					return outcome(['https://b.test']);
				},
			}),
		);
		expect(calls).toEqual(['exa']);
		expect(result.backends).toEqual(['exa']);
		expect(result.sources.map((source) => source.url)).toEqual(['https://a.test']);
		expect(result.unanswered).toEqual([]);
	});

	it('失败时顺延到下一个后端（用户要的语义）', async () => {
		const result = await runSearchChain(
			options(['exa', 'tavily', 'dsh'], {
				exa: async () => {
					throw new Error('HTTP 401（API Key 无效或权限不足）');
				},
				tavily: async () => outcome(['https://tavily.test']),
				dsh: async () => outcome(['https://dsh.test']),
			}),
		);
		expect(result.backends).toEqual(['tavily']);
		expect(result.sources.map((source) => source.url)).toEqual(['https://tavily.test']);
		expect(result.attempts).toEqual([
			{ backend: 'exa', query: 'q1', status: 'failed', detail: 'HTTP 401（API Key 无效或权限不足）' },
			{ backend: 'tavily', query: 'q1', status: 'ok', sources: 1 },
		]);
	});

	it('缺 Key 的后端跳过但记录原因', async () => {
		const result = await runSearchChain(
			options(
				['exa', 'tavily', 'dsh'],
				{ dsh: async () => outcome(['https://dsh.test']) },
				{ unavailable: (backend) => (backend === 'exa' ? '未配置 API Key' : backend === 'tavily' ? '未配置 API Key' : undefined) },
			),
		);
		expect(result.backends).toEqual(['dsh']);
		expect(result.attempts.filter((attempt) => attempt.status === 'skipped')).toHaveLength(2);
		expect(result.attempts[0]).toEqual({ backend: 'exa', query: 'q1', status: 'skipped', detail: '未配置 API Key' });
	});

	it('空结果也算"没结果"，继续顺延', async () => {
		const result = await runSearchChain(
			options(['exa', 'tavily'], {
				exa: async () => outcome([]),
				tavily: async () => outcome(['https://tavily.test']),
			}),
		);
		expect(result.backends).toEqual(['tavily']);
		expect(result.attempts[0]).toEqual({ backend: 'exa', query: 'q1', status: 'empty', sources: 0 });
	});

	it('全部为空时返回空结果而不是报错（确实没搜到）', async () => {
		const result = await runSearchChain(
			options(['exa', 'tavily'], {
				exa: async () => outcome([]),
				tavily: async () => outcome([]),
			}),
		);
		expect(result.sources).toEqual([]);
		expect(result.backends).toEqual(['exa']);
		expect(result.unanswered).toEqual([]);
	});

	it('一部分查询没搜到、一部分查询失败时，两者都不算"有结果"', async () => {
		const result = await runSearchChain(
			options(
				['exa'],
				{
					exa: async (query) => {
						if (query === 'q2') throw new Error('boom');
						return outcome([]);
					},
				},
				{ queries: ['q1', 'q2'] },
			),
		);
		expect(result.sources).toEqual([]);
		// q1 搜到但没有结果，q2 这一档直接失败 → 只有 q2 进 unanswered。
		expect(result.unanswered).toEqual(['q2']);
		expect(result.attempts).toEqual([
			{ backend: 'exa', query: 'q1', status: 'empty', sources: 0 },
			{ backend: 'exa', query: 'q2', status: 'failed', detail: 'boom' },
		]);
	});

	it('全链路失败时抛错，消息里带每个后端的原因', async () => {
		await expect(
			runSearchChain(
				options(
					['exa', 'tavily'],
					{
						exa: async () => {
							throw new Error('请求超时（20000ms）');
						},
					},
					{ unavailable: (backend) => (backend === 'tavily' ? '未配置 API Key' : undefined) },
				),
			),
		).rejects.toThrow(/Exa（请求超时（20000ms））、Tavily（未配置 API Key）/u);
	});

	it('多条查询各自顺延，已答的查询不再打后面的后端', async () => {
		const calls: string[] = [];
		const result = await runSearchChain(
			options(
				['exa', 'tavily'],
				{
					exa: async (query) => {
						calls.push(`exa:${query}`);
						if (query === 'q1') return outcome(['https://a.test']);
						throw new Error('boom');
					},
					tavily: async (query) => {
						calls.push(`tavily:${query}`);
						return outcome([`https://${query}.test`]);
					},
				},
				{ queries: ['q1', 'q2'] },
			),
		);
		expect(calls.sort()).toEqual(['exa:q1', 'exa:q2', 'tavily:q2']);
		expect(result.sources.map((source) => source.url).sort()).toEqual(['https://a.test', 'https://q2.test']);
	});

	it('合并来源时去重并按查询轮转排序（多条查询的摘要带小标题）', async () => {
		const result = await runSearchChain(
			options(
				['exa'],
				{
					exa: async (query) => (query === 'q1' ? outcome(['https://a.test', 'https://shared.test'], '答案1') : outcome(['https://b.test', 'https://shared.test'], '答案2')),
				},
				{ queries: ['q1', 'q2'] },
			),
		);
		expect(result.sources.map((source) => source.url)).toEqual(['https://a.test', 'https://b.test', 'https://shared.test']);
		expect(result.truncated).toBe(false);
		expect(result.content).toBe('### q1\n\n答案1\n\n### q2\n\n答案2');
	});

	it('单条查询的摘要不加小标题', async () => {
		const result = await runSearchChain(options(['exa'], { exa: async () => outcome(['https://a.test'], '答案') }));
		expect(result.content).toBe('答案');
	});

	it('合并来源按上限截断并标记 truncated', async () => {
		const result = await runSearchChain(
			options(
				['exa'],
				{
					exa: async (query) => (query === 'q1' ? outcome(['https://a1.test', 'https://a2.test']) : outcome(['https://b1.test', 'https://b2.test'])),
				},
				{ queries: ['q1', 'q2'], maxResults: 3 },
			),
		);
		expect(result.sources.map((source) => source.url)).toEqual(['https://a1.test', 'https://b1.test', 'https://a2.test']);
		expect(result.truncated).toBe(true);
	});

	it('有查询拿不到结果时记进 unanswered（其余查询照常返回）', async () => {
		const result = await runSearchChain(
			options(
				['exa'],
				{
					exa: async (query) => {
						if (query === 'q2') throw new Error('boom');
						return outcome(['https://a.test']);
					},
				},
				{ queries: ['q1', 'q2'] },
			),
		);
		expect(result.unanswered).toEqual(['q2']);
		expect(result.sources.map((source) => source.url)).toEqual(['https://a.test']);
	});

	it('调用方取消后不再尝试下一个后端', async () => {
		const controller = new AbortController();
		const seen: SearchBackend[] = [];
		await expect(
			runSearchChain(
				options(
					['exa', 'tavily'],
					{
						exa: async () => {
							seen.push('exa');
							controller.abort(new Error('用户打断'));
							throw controller.signal.reason as Error;
						},
						tavily: async () => {
							seen.push('tavily');
							return outcome(['https://tavily.test']);
						},
					},
					{ signal: controller.signal },
				),
			),
		).rejects.toThrow('用户打断');
		expect(seen).toEqual(['exa']);
	});

	it('已取消的信号直接抛出（不发起任何请求）', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runSearchChain(options(['exa'], { exa: async () => outcome(['https://a.test']) }, { signal: controller.signal }))).rejects.toThrow();
	});

	it('onAttempt 逐次回调（service 用它记日志）', async () => {
		const attempts: ChainAttempt[] = [];
		await runSearchChain(
			options(['exa'], { exa: async () => outcome(['https://a.test']) }, { onAttempt: (attempt) => attempts.push(attempt) }),
		);
		expect(attempts).toEqual([{ backend: 'exa', query: 'q1', status: 'ok', sources: 1 }]);
	});
});

describe('SearchChainError / summarizeAttempts', () => {
	it('错误对象带上尝试明细', () => {
		const attempts: ChainAttempt[] = [{ backend: 'exa', query: 'q1', status: 'failed', detail: 'boom' }];
		const error = new SearchChainError('失败', attempts);
		expect(error.attempts).toBe(attempts);
		expect(error.name).toBe('SearchChainError');
	});

	it('每个后端只写一条原因，无尝试时给出兜底文案', () => {
		expect(
			summarizeAttempts([
				{ backend: 'exa', query: 'q1', status: 'failed', detail: 'boom' },
				{ backend: 'exa', query: 'q2', status: 'failed', detail: 'boom again' },
			]),
		).toBe('Exa（boom）');
		expect(summarizeAttempts([])).toContain('没有可用的搜索后端');
	});
});
