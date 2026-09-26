/**
 * 网页搜索的数据面（纯逻辑，可单测）：后端标识、优先级链解析，以及
 * Tavily / Exa 两个 HTTP 后端的请求构造与响应解析。网络调用在 service.ts。
 *
 * 三个后端：
 *  - `exa`    Exa Search API（`POST {base}/search`，`x-api-key` 头）
 *  - `tavily` Tavily Search API（`POST {base}/search`，`Authorization: Bearer` 头）
 *  - `dsh`    宿主 ctx.web 能力缝（即内置 web_search 工具用的那个后端）
 *
 * 解析一律**防御式**：单个来源字段缺失/改名只丢该条来源的对应字段，不整批失败；
 * 只有响应体整体不是预期形状（拿不到 results 数组）才抛错——抛错在链上等于
 * "这个后端这次不行"，由 chain.ts 顺延到下一个后端。
 */
import type { WebSearchResultLike } from '../dsh.ts';
import { SEARCH_BACKEND_IDS, type SearchBackendId } from './priority.ts';

/** 规范化后的后端标识（配置里允许写别名，见 BACKEND_ALIASES；取值见 priority.ts）。 */
export type SearchBackend = SearchBackendId;

/** 全部合法后端（配置说明与 WebUI 文案用）。 */
export const SEARCH_BACKENDS: readonly SearchBackend[] = SEARCH_BACKEND_IDS;

/** 后端展示名（日志、system prompt 提示、错误消息用）。 */
export const SEARCH_BACKEND_LABELS: Record<SearchBackend, string> = {
	exa: 'Exa',
	tavily: 'Tavily',
	dsh: 'dsh 内置',
};

/** Exa 官方端点（配置留空时的默认值）。 */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai';
/** Tavily 官方端点（配置留空时的默认值）。 */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
/** Exa `contents.text.maxCharacters`：每条来源正文的最大字符数。 */
export const EXA_SNIPPET_CHARS = 800;
/** 单条来源摘要的字符上限（Tavily 的 content 有时很长）。 */
export const SNIPPET_MAX_CHARS = 800;
/** 请求 UA（便于对方识别来源；不携带任何用户信息）。 */
export const SEARCH_USER_AGENT = 'dsh-qq-bot';

/** 归一后的一次搜索结果（与 dsh-web 的 WebSearchResult 同形）。 */
export interface SearchOutcome {
	content?: string;
	sources: SearchSource[];
	truncated: boolean;
}

/** 一条来源（与 dsh-web 的 WebSearchSource 同形）。 */
export interface SearchSource {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

/** 一次后端 HTTP 调用的请求描述（service.ts 直接交给 fetch）。 */
export interface BackendRequest {
	url: string;
	init: {
		method: 'POST';
		headers: Record<string, string>;
		body: string;
	};
}

/**
 * 配置里允许的后端写法：`exa` / `tavily` / `dsh` 是规范名，其余为兼容写法
 * （WebUI 用下拉给出规范名，但配置文件/环境变量里可能写成内置工具名，
 * 或把"不用这一档"写成 none/off/skip）。
 */
const BACKEND_ALIASES: Record<string, SearchBackend> = {
	exa: 'exa',
	tavily: 'tavily',
	dsh: 'dsh',
	'dsh-web': 'dsh',
	dsh_web: 'dsh',
	dsh_web_search: 'dsh',
	web_search: 'dsh',
	builtin: 'dsh',
	内置: 'dsh',
};

/** 「这个顺位不用」的写法（归一后为空档）。 */
const DISABLED_CHOICES = new Set(['', 'none', 'off', 'no', 'skip', '不使用', '不用', '关闭']);

/**
 * `searchOrder` 数组 → 归一后的搜索链：保持数组顺序，空档（none/off/空串，
 * 兼容手写配置）跳过，同一后端重复出现只保留最靠前的一次，无法识别的写法
 * 单独返回给调用方提示用户（不静默丢弃）。
 */
export function resolveSearchChain(choices: readonly string[]): { entries: SearchBackend[]; unknown: string[] } {
	const entries: SearchBackend[] = [];
	const unknown: string[] = [];
	for (const item of choices) {
		const trimmed = item.trim();
		const key = trimmed.toLowerCase();
		if (DISABLED_CHOICES.has(key)) continue;
		const backend = BACKEND_ALIASES[key];
		if (backend === undefined) {
			unknown.push(trimmed);
			continue;
		}
		if (!entries.includes(backend)) entries.push(backend);
	}
	return { entries, unknown };
}

/** 把 base 与路径拼成端点（base 为空用官方默认值，尾部斜杠容错）。 */
export function endpointOf(baseUrl: string, fallback: string, path: string): string {
	const base = baseUrl.trim() === '' ? fallback : baseUrl.trim();
	return `${base.replace(/\/+$/u, '')}${path}`;
}

/** Exa 搜索请求（`contents.text` 让每条来源带回正文摘要）。 */
export function buildExaRequest(options: { query: string; maxResults: number; apiKey: string; baseUrl?: string }): BackendRequest {
	return {
		url: endpointOf(options.baseUrl ?? '', EXA_DEFAULT_BASE_URL, '/search'),
		init: {
			method: 'POST',
			headers: {
				'x-api-key': options.apiKey,
				'content-type': 'application/json',
				accept: 'application/json',
				'user-agent': SEARCH_USER_AGENT,
			},
			body: JSON.stringify({
				query: options.query,
				numResults: options.maxResults,
				type: 'auto',
				contents: { text: { maxCharacters: EXA_SNIPPET_CHARS } },
			}),
		},
	};
}

/** Tavily 搜索请求（`include_answer` 让回答摘要走同一个端点返回）。 */
export function buildTavilyRequest(options: { query: string; maxResults: number; apiKey: string; baseUrl?: string }): BackendRequest {
	return {
		url: endpointOf(options.baseUrl ?? '', TAVILY_DEFAULT_BASE_URL, '/search'),
		init: {
			method: 'POST',
			headers: {
				authorization: `Bearer ${options.apiKey}`,
				'content-type': 'application/json',
				accept: 'application/json',
				'user-agent': SEARCH_USER_AGENT,
			},
			body: JSON.stringify({
				query: options.query,
				search_depth: 'basic',
				max_results: options.maxResults,
				include_answer: true,
				include_raw_content: false,
			}),
		},
	};
}

/** 解析 Exa 响应（`{ results: [{ title, url, publishedDate, text }] }`）。 */
export function parseExaResponse(payload: unknown): SearchOutcome {
	const root = asRecord(payload);
	const results = root?.['results'];
	if (!Array.isArray(results)) throw new Error('响应缺少 results 数组（不是 Exa Search API 的应答？）');
	const sources: SearchSource[] = [];
	for (const item of results) {
		const record = asRecord(item);
		const url = record === undefined ? undefined : asString(record['url']);
		if (url === undefined || url === '') continue;
		sources.push(
			toSource({
				url,
				title: asString(record?.['title']),
				snippet: truncateSnippet(asString(record?.['text']) ?? '', SNIPPET_MAX_CHARS),
				publishedAt: asString(record?.['publishedDate']) ?? asString(record?.['published_date']),
			}),
		);
	}
	return { sources, truncated: false };
}

/** 解析 Tavily 响应（`{ answer, results: [{ title, url, content, published_date }] }`）。 */
export function parseTavilyResponse(payload: unknown): SearchOutcome {
	const root = asRecord(payload);
	const results = root?.['results'];
	if (!Array.isArray(results)) throw new Error('响应缺少 results 数组（不是 Tavily Search API 的应答？）');
	const sources: SearchSource[] = [];
	for (const item of results) {
		const record = asRecord(item);
		const url = record === undefined ? undefined : asString(record['url']);
		if (url === undefined || url === '') continue;
		sources.push(
			toSource({
				url,
				title: asString(record?.['title']),
				snippet: truncateSnippet(asString(record?.['content']) ?? '', SNIPPET_MAX_CHARS),
				// Tavily 的 news 主题返回 published_date，普通搜索可能两者都没有。
				publishedAt: asString(record?.['published_date']) ?? asString(record?.['publishedDate']),
			}),
		);
	}
	return { ...answerOf(asString(root?.['answer'])), sources, truncated: false };
}

/** 把 ctx.web 的搜索结果归一为本模块的形状（宿主侧字段可能缺省）。 */
export function fromSeamResult(result: WebSearchResultLike, maxResults: number): SearchOutcome {
	const sources: SearchSource[] = [];
	for (const item of result.sources ?? []) {
		if (typeof item?.url !== 'string' || item.url === '') continue;
		sources.push(
			toSource({
				url: item.url,
				title: typeof item.title === 'string' ? item.title : undefined,
				snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
				publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : undefined,
			}),
		);
	}
	const limit = Math.max(0, maxResults);
	return {
		...answerOf(typeof result.content === 'string' ? result.content : undefined),
		sources: sources.slice(0, limit),
		truncated: result.truncated === true || sources.length > limit,
	};
}

/** 从错误响应体里取一句人话（兼容各家不同的错误报文形状）。 */
export function responseErrorMessage(payload: unknown): string | undefined {
	const root = asRecord(payload);
	if (root === undefined) return undefined;
	for (const key of ['error', 'message', 'detail', 'msg']) {
		const value = root[key];
		const nested = asRecord(value);
		const text = typeof value === 'string' ? value : asString(nested?.['message'] ?? nested?.['error'] ?? nested?.['detail']);
		if (text !== undefined && text.trim() !== '') return text.trim().slice(0, 300);
	}
	// FastAPI 风格：detail 是 [{ msg: ... }]。
	const detail = root['detail'];
	if (Array.isArray(detail)) {
		for (const item of detail) {
			const text = asString(asRecord(item)?.['msg']);
			if (text !== undefined && text.trim() !== '') return text.trim().slice(0, 300);
		}
	}
	return undefined;
}

/** HTTP 状态码的中文解释（拼进错误消息，让用户知道该改什么）。 */
export function describeHttpStatus(status: number): string {
	if (status === 401 || status === 403) return 'API Key 无效或权限不足';
	if (status === 404) return '端点不存在（检查 API 基址）';
	if (status === 429) return '请求过于频繁或额度用尽';
	if (status >= 500) return '对方服务端错误';
	return '请求被拒绝';
}

/** 摘要截断（带省略号；空文本返回 undefined，便于整体省略该字段）。 */
export function truncateSnippet(text: string, maxChars: number): string | undefined {
	const trimmed = text.trim();
	if (trimmed === '') return undefined;
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/** 尝试把文本解析成 JSON（拿不到就返回 undefined，不抛错）。 */
export function parseJsonMaybe(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** 组装一条来源：只带上真正取到的字段（JSON 输出里不留 undefined 键）。 */
function toSource(fields: { url: string; title?: string; snippet?: string; publishedAt?: string }): SearchSource {
	return {
		url: fields.url,
		...optional('title', fields.title),
		...optional('snippet', fields.snippet),
		...optional('publishedAt', fields.publishedAt),
	};
}

/** 可选的回答摘要字段（空串视为没有）。 */
function answerOf(content: string | undefined): { content?: string } {
	return content !== undefined && content.trim() !== '' ? { content: content.trim() } : {};
}

/** `{ key: value }` 或 `{}`（value 为空时不写这个键）。 */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
	return value !== undefined && value !== '' ? ({ [key]: value } as { [P in K]?: string }) : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
