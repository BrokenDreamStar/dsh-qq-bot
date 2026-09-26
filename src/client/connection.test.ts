import { describe, expect, it } from 'vitest';
import { CONNECTION_STATUS_ENDPOINT, fetchTransportConnected, readConnected } from './connection.ts';
import type { RpcCallResult, RpcCaller } from './types.ts';

/** 固定应答（或抛异常）的假调用器。 */
function caller(result: RpcCallResult | Error): RpcCaller {
	return async () => {
		if (result instanceof Error) throw result;
		return result;
	};
}

describe('readConnected', () => {
	it('只认 connected === true', () => {
		expect(readConnected({ connected: true })).toBe(true);
		expect(readConnected({ connected: false })).toBe(false);
		expect(readConnected({ connected: 'true' })).toBe(false);
		expect(readConnected({})).toBe(false);
		expect(readConnected(null)).toBe(false);
		expect(readConnected(undefined)).toBe(false);
		expect(readConnected('connected')).toBe(false);
	});
});

describe('fetchTransportConnected', () => {
	it('走 status/connection 端点并取 value.connected', async () => {
		const endpoints: string[] = [];
		const call: RpcCaller = async (endpoint) => {
			endpoints.push(endpoint);
			return { ok: true, value: { connected: true } };
		};
		await expect(fetchTransportConnected(call)).resolves.toBe(true);
		expect(endpoints).toEqual([CONNECTION_STATUS_ENDPOINT]);
	});

	it('未连接 / 宿主报错 / 端点抛异常都视为未连接', async () => {
		await expect(fetchTransportConnected(caller({ ok: true, value: { connected: false } }))).resolves.toBe(false);
		await expect(fetchTransportConnected(caller({ ok: true, value: {} }))).resolves.toBe(false);
		await expect(fetchTransportConnected(caller({ ok: false, error: { code: 'not-found', message: '未知端点' } }))).resolves.toBe(false);
		await expect(fetchTransportConnected(caller(new Error('rpc down')))).resolves.toBe(false);
	});
});
