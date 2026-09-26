import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createWebRpcHandler, endpointFromPath, registerWebRpcChannel } from './webRpc.ts';
import type { ConnectionRpcResultLike } from './dsh.ts';
import type { Logger } from './types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const CHANNEL = '/dsh-qq-bot';

/** 极简 IncomingMessage 替身：buffer 请求体 + close 事件。 */
class FakeRequest extends EventEmitter {
	method = 'POST';
	url = `${CHANNEL}/personas/list`;
	headers: Record<string, string> = { 'content-type': 'application/json' };
	body = '';
	destroyed = false;
	destroy(): void {
		this.destroyed = true;
	}
}

interface FakeResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	headersSent: boolean;
	writeHead(status: number, headers?: Record<string, string>): void;
	end(chunk?: string): void;
}

function fakeResponse(): FakeResponse {
	return {
		status: 0,
		headers: {},
		text: '',
		headersSent: false,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers ?? {};
			this.headersSent = true;
		},
		end(chunk) {
			this.text = chunk ?? '';
			this.headersSent = true;
		},
	};
}

/** 驱动一次请求：写 body、end，然后跑 handler。 */
async function invoke(handler: (req: never, res: never) => Promise<void>, request: FakeRequest, response: FakeResponse): Promise<void> {
	const pending = handler(request as never, response as never);
	request.emit('data', Buffer.from(request.body));
	request.emit('end');
	await pending;
}

function makeHandler(handler: (endpoint: string, payload: unknown) => Promise<ConnectionRpcResultLike>, rejection?: number) {
	return createWebRpcHandler({
		webServer: { register: () => () => {} },
		connection: { requestRejection: () => rejection },
		channel: CHANNEL,
		handler: (endpoint, payload) => handler(endpoint, payload),
		logger,
	});
}

function envelope(method: string, payload: unknown = {}): string {
	return JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload });
}

describe('endpointFromPath', () => {
	it('剥出通道后的端点（含多段）', () => {
		expect(endpointFromPath(CHANNEL, `${CHANNEL}/personas/list`)).toBe('personas/list');
		expect(endpointFromPath(CHANNEL, `${CHANNEL}/status`)).toBe('status');
	});

	it('不匹配的路径与非法段返回 undefined', () => {
		expect(endpointFromPath(CHANNEL, '/other/personas/list')).toBeUndefined();
		expect(endpointFromPath(CHANNEL, CHANNEL)).toBeUndefined();
		expect(endpointFromPath(CHANNEL, `${CHANNEL}/`)).toBeUndefined();
		expect(endpointFromPath(CHANNEL, `${CHANNEL}/a//b`)).toBeUndefined();
		expect(endpointFromPath(CHANNEL, `${CHANNEL}/../etc/passwd`)).toBeUndefined();
		expect(endpointFromPath(CHANNEL, `${CHANNEL}/有中文`)).toBeUndefined();
	});
});

describe('createWebRpcHandler', () => {
	it('鉴权拒绝时直接返回 401，不进入业务处理', async () => {
		const handler = makeHandler(vi.fn(), 401);
		const response = fakeResponse();
		await invoke(handler, new FakeRequest(), response);
		expect(response.status).toBe(401);
		expect(response.text).toBe('unauthorized');
	});

	it('鉴权通过后返回 server-response 信封', async () => {
		const seen: Array<[string, unknown]> = [];
		const handler = makeHandler(async (endpoint, payload) => {
			seen.push([endpoint, payload]);
			return { ok: true, value: { rows: [] } };
		});
		const request = new FakeRequest();
		request.body = envelope('personas/list', { limit: 3 });
		const response = fakeResponse();
		await invoke(handler, request, response);
		expect(seen).toEqual([['personas/list', { limit: 3 }]]);
		expect(response.status).toBe(200);
		expect(JSON.parse(response.text)).toEqual({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { rows: [] } } });
	});

	it('非 POST 与未知路径返回 404（不再落到静态兜底的 405）', async () => {
		const handler = makeHandler(async () => ({ ok: true, value: null }));
		const get = new FakeRequest();
		get.method = 'GET';
		const responseA = fakeResponse();
		await invoke(handler, get, responseA);
		expect(responseA.status).toBe(404);

		const unknown = new FakeRequest();
		unknown.url = '/elsewhere/x';
		const responseB = fakeResponse();
		await invoke(handler, unknown, responseB);
		expect(responseB.status).toBe(404);
	});

	it('content-type / JSON / 信封非法时返回对应错误', async () => {
		const handler = makeHandler(async () => ({ ok: true, value: null }));

		const wrongType = new FakeRequest();
		wrongType.headers = { 'content-type': 'text/plain' };
		const responseA = fakeResponse();
		await invoke(handler, wrongType, responseA);
		expect(responseA.status).toBe(415);

		const badJson = new FakeRequest();
		badJson.body = '{not json';
		const responseB = fakeResponse();
		await invoke(handler, badJson, responseB);
		expect(responseB.status).toBe(400);

		const notEnvelope = new FakeRequest();
		notEnvelope.body = '[]';
		const responseC = fakeResponse();
		await invoke(handler, notEnvelope, responseC);
		expect(responseC.status).toBe(400);
	});

	it('method 与端点不一致时回 gateway/bad-request（HTTP 200）', async () => {
		const handler = makeHandler(async () => ({ ok: true, value: null }));
		const request = new FakeRequest();
		request.body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-9', method: 'routes/list', payload: {} });
		const response = fakeResponse();
		await invoke(handler, request, response);
		expect(response.status).toBe(200);
		expect(JSON.parse(response.text)).toMatchObject({ rpcId: 'rpc-9', result: { ok: false, error: { code: 'gateway/bad-request' } } });
	});

	it('业务处理器抛错时返回 500 而不是静默断开', async () => {
		const handler = makeHandler(async () => {
			throw new Error('boom');
		});
		const request = new FakeRequest();
		request.body = envelope('personas/list');
		const response = fakeResponse();
		await invoke(handler, request, response);
		expect(response.status).toBe(500);
		expect(response.text).toContain('boom');
	});
});

describe('registerWebRpcChannel', () => {
	it('在 webServer 上注册 channel 的 prefix 路由并返回注销函数', () => {
		const dispose = vi.fn();
		const register = vi.fn(() => dispose);
		const returned = registerWebRpcChannel({
			webServer: { register },
			connection: { requestRejection: () => undefined },
			channel: CHANNEL,
			handler: async () => ({ ok: true, value: null }),
			logger,
		});
		expect(register).toHaveBeenCalledTimes(1);
		expect(register.mock.calls[0]?.[0]).toMatchObject({ kind: 'prefix', path: CHANNEL });
		expect(returned).toBe(dispose);
	});
});
