import { describe, expect, it } from 'vitest';
import {
	buildExaRequest,
	buildTavilyRequest,
	describeHttpStatus,
	endpointOf,
	fromSeamResult,
	resolveSearchChain,
	parseExaResponse,
	parseJsonMaybe,
	parseTavilyResponse,
	responseErrorMessage,
	truncateSnippet,
} from './providers.ts';

describe('resolveSearchChain', () => {
	it('保持列表顺序（数组顺序 = 尝试顺序）', () => {
		expect(resolveSearchChain(['exa', 'tavily', 'dsh']).entries).toEqual(['exa', 'tavily', 'dsh']);
		expect(resolveSearchChain(['tavily', 'dsh', 'none']).entries).toEqual(['tavily', 'dsh']);
	});

	it('手写配置里的 none / off / 空串 = 该项不参与，其余项不受影响', () => {
		expect(resolveSearchChain(['exa', 'none', 'dsh']).entries).toEqual(['exa', 'dsh']);
		expect(resolveSearchChain(['off', '', 'tavily']).entries).toEqual(['tavily']);
		expect(resolveSearchChain(['none', 'none', 'none']).entries).toEqual([]);
	});

	it('同一后端重复出现只保留最靠前的一次', () => {
		expect(resolveSearchChain(['tavily', 'exa', 'tavily']).entries).toEqual(['tavily', 'exa']);
	});

	it('兼容配置文件里的别名写法', () => {
		expect(resolveSearchChain(['web_search', 'EXA', 'dsh_web_search']).entries).toEqual(['dsh', 'exa']);
	});

	it('未知写法单独返回（不静默丢弃）', () => {
		const parsed = resolveSearchChain(['exa', 'bing', 'none']);
		expect(parsed.entries).toEqual(['exa']);
		expect(parsed.unknown).toEqual(['bing']);
	});
});

describe('endpointOf', () => {
	it('空基址用官方默认值，尾部斜杠容错', () => {
		expect(endpointOf('', 'https://api.exa.ai', '/search')).toBe('https://api.exa.ai/search');
		expect(endpointOf('https://relay.local/exa/', 'https://api.exa.ai', '/search')).toBe('https://relay.local/exa/search');
	});
});

describe('请求构造', () => {
	it('Exa 用 x-api-key 头 + contents.text', () => {
		const request = buildExaRequest({ query: '今天天气', maxResults: 3, apiKey: 'exa-key' });
		expect(request.url).toBe('https://api.exa.ai/search');
		expect(request.init.headers['x-api-key']).toBe('exa-key');
		const body = JSON.parse(request.init.body) as Record<string, unknown>;
		expect(body['numResults']).toBe(3);
		expect(body['query']).toBe('今天天气');
		expect(body['contents']).toEqual({ text: { maxCharacters: 800 } });
	});

	it('Tavily 用 Bearer 头 + include_answer', () => {
		const request = buildTavilyRequest({ query: 'news', maxResults: 5, apiKey: 'tvly-key', baseUrl: 'https://relay.local' });
		expect(request.url).toBe('https://relay.local/search');
		expect(request.init.headers['authorization']).toBe('Bearer tvly-key');
		const body = JSON.parse(request.init.body) as Record<string, unknown>;
		expect(body['max_results']).toBe(5);
		expect(body['include_answer']).toBe(true);
	});
});

describe('parseExaResponse', () => {
	it('映射 title/url/text/publishedDate，丢弃没有 url 的条目', () => {
		const outcome = parseExaResponse({
			results: [
				{ title: '标题', url: 'https://a.test', text: '正文', publishedDate: '2025-01-02T00:00:00.000Z' },
				{ title: '没有 url' },
				{ url: 'https://b.test' },
			],
		});
		expect(outcome.sources).toEqual([
			{ url: 'https://a.test', title: '标题', snippet: '正文', publishedAt: '2025-01-02T00:00:00.000Z' },
			{ url: 'https://b.test' },
		]);
		expect(outcome.truncated).toBe(false);
	});

	it('响应形状不对时抛错（链上等于这一档失败）', () => {
		expect(() => parseExaResponse({ message: 'oops' })).toThrow(/results/);
		expect(() => parseExaResponse(null)).toThrow(/results/);
	});

	it('空 results 是有效空结果', () => {
		expect(parseExaResponse({ results: [] })).toEqual({ sources: [], truncated: false });
	});
});

describe('parseTavilyResponse', () => {
	it('映射 answer 与 results[].content/published_date', () => {
		const outcome = parseTavilyResponse({
			answer: '  摘要  ',
			results: [{ title: '标题', url: 'https://a.test', content: '片段', published_date: '2025-03-04' }],
		});
		expect(outcome.content).toBe('摘要');
		expect(outcome.sources).toEqual([{ url: 'https://a.test', title: '标题', snippet: '片段', publishedAt: '2025-03-04' }]);
	});

	it('缺 answer 时不写 content', () => {
		const outcome = parseTavilyResponse({ results: [{ url: 'https://a.test' }] });
		expect(outcome.content).toBeUndefined();
		expect(outcome.sources).toEqual([{ url: 'https://a.test' }]);
	});
});

describe('fromSeamResult', () => {
	it('归一 ctx.web 结果并按上限截断', () => {
		const outcome = fromSeamResult(
			{
				content: '答案',
				sources: [
					{ url: 'https://a.test', title: 'A' },
					{ url: 'https://b.test' },
					{ url: '' },
				],
				truncated: false,
			},
			1,
		);
		expect(outcome.content).toBe('答案');
		expect(outcome.sources).toEqual([{ url: 'https://a.test', title: 'A' }]);
		expect(outcome.truncated).toBe(true);
	});
});

describe('错误信息提取', () => {
	it('兼容常见错误报文形状', () => {
		expect(responseErrorMessage({ error: 'bad key' })).toBe('bad key');
		expect(responseErrorMessage({ error: { message: 'nested' } })).toBe('nested');
		expect(responseErrorMessage({ detail: 'plain detail' })).toBe('plain detail');
		expect(responseErrorMessage({ detail: [{ msg: 'fastapi style' }] })).toBe('fastapi style');
		expect(responseErrorMessage('not an object')).toBeUndefined();
	});

	it('状态码解释', () => {
		expect(describeHttpStatus(401)).toContain('API Key');
		expect(describeHttpStatus(429)).toContain('额度');
		expect(describeHttpStatus(503)).toContain('服务端');
	});

	it('JSON 解析失败不抛错', () => {
		expect(parseJsonMaybe('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonMaybe('<html>')).toBeUndefined();
	});

	it('摘要截断', () => {
		expect(truncateSnippet('  hello  ', 10)).toBe('hello');
		expect(truncateSnippet('', 10)).toBeUndefined();
		expect(truncateSnippet('abcdef', 3)).toBe('abc…');
	});
});
