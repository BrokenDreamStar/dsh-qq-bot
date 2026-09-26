/**
 * 自建 WebUI RPC 通道（宿主半）：在 `webServer` 上挂一条 prefix 路由，
 * 自己实现 dsh-client-connection 的 RPC 报文与鉴权。
 *
 * 为什么不用 `connection.rpc.handle('/xxx', handler)`：它内部用
 * `owner.webServer` 挂路由，而 cordis 的 Service tracker 在 shadow 代理下会把
 * owner 解析到一个读不到 `webServer` 的上下文，实测抛
 * `cannot get property "webServer" without inject`，路由永远不注册（表现为
 * 客户端 POST `/dsh-qq-bot/<endpoint>` 落到前端静态兜底 → **HTTP 405**）。
 * 也不能用 `connection.rpc.intercept('/api', ...)`：共享 `/api` 通道的
 * interceptor 已被 `dsh-api-gateway` 独占（重复注册会抛错）。
 *
 * 报文格式与 `dsh-client-connection` 的 `rpcFetchHandler` 完全一致，客户端
 * `connection.rpc.call(channel, endpoint, payload)` 无需任何改动：
 *   POST <channel>/<endpoint>，content-type: application/json
 *   { type: 'client-request', rpcId, method: <endpoint>, payload }
 *   → 200 { type: 'server-response', rpcId, result: {ok:true,value} | {ok:false,error:{code,message,details}} }
 * 鉴权复用 connection 服务的 `requestRejection`（Host/Origin 栅栏 + 浏览器 cookie）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionRpcResultLike } from './dsh.ts';
import type { Logger } from './types.ts';

/** 请求体上限（WebUI 配置报文很小；超限直接 400，避免内存被撑爆）。 */
const MAX_BODY_BYTES = 1 << 20;
/** 端点段允许的字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 一致）。 */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;

/** `webServer.register` 的最小面（只用到 prefix 路由）。 */
export interface WebServerLike {
	register(route: { kind: 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void;
}

/** `connection` 服务里我们用到的最小面：Host/Origin 栅栏 + 浏览器鉴权。 */
export interface ConnectionFenceLike {
	/** 返回 401 / 403 表示拒绝；undefined 表示放行。 */
	requestRejection(request: IncomingMessage): number | undefined;
}

export interface WebRpcChannelOptions {
	webServer: WebServerLike;
	connection: ConnectionFenceLike;
	/** 通道前缀，如 '/dsh-qq-bot'（必须与浏览器侧调用一致）。 */
	channel: string;
	/** 端点处理器：返回 Connection RPC 结果信封的内容。 */
	handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResultLike>;
	logger: Logger;
}

/** `<channel>/<endpoint>` → endpoint；不匹配返回 undefined。 */
export function endpointFromPath(channel: string, pathname: string): string | undefined {
	if (!pathname.startsWith(`${channel}/`)) return undefined;
	const endpoint = pathname.slice(channel.length + 1);
	if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) return undefined;
	return endpoint;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		request.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				reject(error);
			}
		});
		request.on('error', reject);
	});
}

function writeText(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
	response.end(text);
}

function writeResult(response: ServerResponse, rpcId: string, result: ConnectionRpcResultLike): void {
	const text = JSON.stringify({ type: 'server-response', rpcId, result });
	response.writeHead(200, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text),
	});
	response.end(text);
}

function fail(code: string, message: string): ConnectionRpcResultLike {
	return { ok: false, error: { code, message } };
}

/** 构造 prefix 路由的 node:http 处理器。 */
export function createWebRpcHandler(options: WebRpcChannelOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
	const { channel, connection, handler, logger } = options;
	return async function handleChannel(request, response) {
		try {
			const rejection = connection.requestRejection(request);
			if (rejection !== undefined) {
				writeText(response, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
				return;
			}
			const url = new URL(typeof request.url === 'string' ? request.url : '/', 'http://dsh.invalid');
			const endpoint = endpointFromPath(channel, url.pathname);
			if (request.method !== 'POST' || endpoint === undefined) {
				writeText(response, 404, 'not found');
				return;
			}
			const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
			if (contentType !== 'application/json') {
				writeText(response, 415, 'content type must be application/json');
				return;
			}
			let body: unknown;
			try {
				body = await readJsonBody(request);
			} catch {
				writeText(response, 400, 'body is not JSON');
				return;
			}
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				writeText(response, 400, 'body is not a client-request envelope');
				return;
			}
			const envelope = body as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
			const rpcId = typeof envelope.rpcId === 'string' && envelope.rpcId !== '' ? envelope.rpcId : 'invalid-request';
			if (envelope.type !== 'client-request' || typeof envelope.method !== 'string') {
				writeResult(response, rpcId, fail('gateway/bad-request', 'invalid client-request message'));
				return;
			}
			if (envelope.method !== endpoint) {
				writeResult(response, rpcId, fail('gateway/bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`));
				return;
			}
			const controller = new AbortController();
			request.once('close', () => {
				controller.abort();
			});
			writeResult(response, rpcId, await handler(endpoint, envelope.payload, controller.signal));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`dsh-qq-bot: RPC 请求处理失败（${channel}）：${message}`);
			if (!response.headersSent) writeText(response, 500, `handler failure: ${message}`);
			else response.end();
		}
	};
}

/**
 * 在 webServer 上注册通道路由；返回注销函数（挂到调用者 fiber 的 effect 上）。
 * 注册失败（例如同一路径重复注册）会抛出，由调用方记录日志而不是静默变 405。
 */
export function registerWebRpcChannel(options: WebRpcChannelOptions): () => void {
	return options.webServer.register({
		kind: 'prefix',
		path: options.channel,
		handler: createWebRpcHandler(options),
	});
}
