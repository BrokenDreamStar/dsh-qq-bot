import { describe, expect, it, vi } from 'vitest';
import { SearchService, clampMaxResults, clampTimeoutMs } from './service.ts';
import type { DshQQConfig } from '../config.ts';
import type { MessageLogEntry } from '../logs/store.ts';
import type { WebSearchSeamLike } from '../dsh.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function baseConfig(overrides: Partial<DshQQConfig> = {}): DshQQConfig {
	return {
		searchEnabled: true,
		searchOrder: ['exa', 'tavily', 'dsh'],
		exaApiKey: 'exa-key',
		exaBaseUrl: '',
		tavilyApiKey: 'tvly-key',
		tavilyBaseUrl: '',
		searchMaxResults: 5,
		searchMaxQueries: 4,
		searchTimeoutMs: 5000,
		...overrides,
	} as DshQQConfig;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

/** 记录一条日志的最小替身（只用到 record）。 */
function fakeLogs(): { entries: Array<Omit<MessageLogEntry, 'seq' | 'ts'>> } {
	return { entries: [] };
}

describe('SearchService 配置解读', () => {
	it('chainDescription 标出不可用的档位与无法识别的条目', () => {
		const service = new SearchService({
			config: baseConfig({ exaApiKey: '', searchOrder: ['exa', 'bing', 'dsh'] }),
			logger,
		});
		expect(service.configuredChain()).toEqual(['exa', 'dsh']);
		expect(service.chainDescription()).toBe('Exa（未配置 API Key） → dsh 内置（宿主无 ctx.web） → 无法识别：bing');
	});

	it('dsh 档在宿主没有 ctx.web 时算不可用', () => {
		const service = new SearchService({ config: baseConfig({ searchOrder: ['dsh'] }), logger });
		expect(service.unavailableBackend('dsh')).toBe('宿主无 ctx.web');
		const withSeam = new SearchService({ config: baseConfig({ searchOrder: ['dsh'] }), logger, getWeb: () => ({ search: async () => ({ sources: [], truncated: false }) }) });
		expect(withSeam.unavailableBackend('dsh')).toBeUndefined();
	});

	it('hintSection 在关闭或链为空时为空串', () => {
		expect(new SearchService({ config: baseConfig({ searchEnabled: false }), logger }).hintSection()).toBe('');
		expect(new SearchService({ config: baseConfig({ searchOrder: [] }), logger }).hintSection()).toBe('');
	});

	it('hintSection 说明优先级链，缺 Key 时提示补 Key', () => {
		const hint = new SearchService({ config: baseConfig(), logger }).hintSection();
		expect(hint).toContain('qq_web_search');
		expect(hint).toContain('Exa → Tavily → dsh 内置');
		const empty = new SearchService({ config: baseConfig({ exaApiKey: '', tavilyApiKey: '' }), logger }).hintSection();
		expect(empty).toContain('没有任何可用后端');
	});
});

describe('SearchService.run', () => {
	it('exa 失败时顺延到 tavily（真实请求路径 + 日志记录）', async () => {
		const logs = fakeLogs();
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const target = String(url);
			if (target.startsWith('https://api.exa.ai')) return jsonResponse({ error: 'invalid api key' }, 401);
			return jsonResponse({ answer: '答案', results: [{ title: 'T', url: 'https://tavily.test', content: '片段' }] });
		});
		const service = new SearchService({
			config: baseConfig(),
			logger,
			logs: { record: (entry) => logs.entries.push(entry) } as never,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const result = await service.run({ queries: ['q1'], chatType: 'group', chatId: '888' });
		expect(result.backends).toEqual(['tavily']);
		expect(result.content).toBe('答案');
		expect(result.sources).toEqual([{ url: 'https://tavily.test', title: 'T', snippet: '片段' }]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(logs.entries).toHaveLength(1);
		expect(logs.entries[0]).toMatchObject({ dir: 'sys', scope: 'search', event: 'search', chatType: 'group', chatId: '888' });
		expect(logs.entries[0]?.detail).toContain('Exa（HTTP 401（API Key 无效或权限不足：invalid api key））');
	});

	it('缺 Key 的档位跳过，直接走 dsh 内置（ctx.web）', async () => {
		const searches: string[] = [];
		const seam: WebSearchSeamLike = {
			search: async (request) => {
				searches.push(request.query);
				return { sources: [{ url: 'https://dsh.test', title: 'D' }], truncated: false };
			},
		};
		const service = new SearchService({
			config: baseConfig({ exaApiKey: '', tavilyApiKey: '' }),
			logger,
			getWeb: () => seam,
			fetchImpl: (() => {
				throw new Error('不该发起 HTTP 请求');
			}) as unknown as typeof fetch,
		});
		const result = await service.run({ queries: ['天气'] });
		expect(searches).toEqual(['天气']);
		expect(result.backends).toEqual(['dsh']);
		expect(result.sources.map((source) => source.url)).toEqual(['https://dsh.test']);
	});

	it('链为空时给出可操作的报错', async () => {
		const service = new SearchService({ config: baseConfig({ searchOrder: [] }), logger });
		await expect(service.run({ queries: ['q'] })).rejects.toThrow(/搜索顺序列表为空/u);
	});

	it('全链路失败时抛错并记一条 search-error 日志', async () => {
		const logs = fakeLogs();
		const service = new SearchService({
			config: baseConfig({ searchOrder: ['exa'] }),
			logger,
			logs: { record: (entry) => logs.entries.push(entry) } as never,
			fetchImpl: (async () => jsonResponse({ error: 'quota exceeded' }, 429)) as unknown as typeof fetch,
		});
		await expect(service.run({ queries: ['q'], chatId: '1' })).rejects.toThrow(/quota exceeded/u);
		expect(logs.entries).toHaveLength(1);
		expect(logs.entries[0]?.event).toBe('search-error');
		expect(logs.entries[0]?.detail).toContain('Exa（HTTP 429');
	});

	it('超时会顺延到下一个后端', async () => {
		const service = new SearchService({
			config: baseConfig({ searchOrder: ['exa', 'tavily'], searchTimeoutMs: 1000 }),
			logger,
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).startsWith('https://api.exa.ai')) {
					// 永不返回，直到 signal 中止（模拟超时）。
					return await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
					});
				}
				return jsonResponse({ results: [{ url: 'https://tavily.test' }] });
			}) as unknown as typeof fetch,
		});
		const result = await service.run({ queries: ['q'] });
		expect(result.backends).toEqual(['tavily']);
	});

	it('调用方取消不会顺延（原样抛出取消原因）', async () => {
		const controller = new AbortController();
		const service = new SearchService({
			config: baseConfig({ searchOrder: ['exa', 'tavily'] }),
			logger,
			fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
				controller.abort(new Error('工具超时'));
				return await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
					if (init?.signal?.aborted === true) reject(init.signal.reason);
				});
			}) as unknown as typeof fetch,
		});
		await expect(service.run({ queries: ['q'], signal: controller.signal })).rejects.toThrow('工具超时');
	});
});

describe('夹取', () => {
	it('结果条数与超时都被夹进安全区间', () => {
		expect(clampMaxResults(0)).toBe(1);
		expect(clampMaxResults(100)).toBe(20);
		expect(clampMaxResults(Number.NaN)).toBe(8);
		expect(clampTimeoutMs(10)).toBe(1000);
		expect(clampTimeoutMs(999999)).toBe(120000);
	});
});
