/** createLogStreamResponse：SSE 快照/追加/清空帧、limit 解析、断开清理与落后丢帧。 */
import { describe, expect, it } from 'vitest';
import { MessageLogService, type MessageLogEntry } from './store.ts';
import { createLogStreamResponse, encodeSseFrame, normalizeLogStreamLimit, type LogStreamFrame } from './stream.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const decoder = new TextDecoder();

function makeService(max = 500): MessageLogService {
	const service = new MessageLogService({ logger, dataDir: '/tmp/dsh-qq-log-stream-test-unused' });
	service.reconfigure({ messageLog: true, messageLogMax: max, messageLogToFile: false });
	return service;
}

function makeRequest(url = 'http://127.0.0.1:3080/api/dsh-qq-bot/logs/stream', signal?: AbortSignal): Request {
	return new Request(url, signal === undefined ? {} : { signal });
}

/** 读一帧：跳过注释/心跳；超时返回 undefined，流结束返回 null。 */
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 300): Promise<LogStreamFrame | null | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		const outcome = await Promise.race([
			reader.read(),
			new Promise<'timeout'>((resolve) => {
				setTimeout(() => resolve('timeout'), remaining);
			}),
		]);
		if (outcome === 'timeout') return undefined;
		if (outcome.done) return null;
		const line = decoder
			.decode(outcome.value)
			.split('\n')
			.find((item) => item.startsWith('data: '));
		if (line !== undefined) return JSON.parse(line.slice('data: '.length)) as LogStreamFrame;
	}
}

/** 断言是快照帧并返回条目。 */
function snapshotEntries(frame: LogStreamFrame | null | undefined): MessageLogEntry[] {
	expect(frame?.kind).toBe('snapshot');
	return frame !== null && frame !== undefined && frame.kind === 'snapshot' ? frame.entries : [];
}

describe('createLogStreamResponse', () => {
	it('连接先发快照，之后即时推送 append 与 clear', async () => {
		const service = makeService();
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: '旧' });
		const controller = new AbortController();
		const response = createLogStreamResponse(service, makeRequest(undefined, controller.signal), { heartbeatMs: 100000 });
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const reader = response.body!.getReader();

		const snapshot = snapshotEntries(await readFrame(reader));
		expect(snapshot.map((entry) => entry.text)).toEqual(['旧']);

		service.record({ dir: 'out', scope: 'dsh', event: 'reply', text: '新' });
		const append = await readFrame(reader);
		expect(append?.kind).toBe('append');
		expect(append !== null && append !== undefined && append.kind === 'append' ? append.entry.text : '').toBe('新');

		service.clear();
		expect((await readFrame(reader))?.kind).toBe('clear');
		controller.abort();
	});

	it('快照条数取 URL 的 limit（并归一化非法值）', async () => {
		const service = makeService();
		for (let i = 1; i <= 5; i++) {
			service.record({ dir: 'in', scope: 'onebot', event: 'message', text: `m${i}` });
		}
		const controller = new AbortController();
		const url = 'http://127.0.0.1:3080/api/dsh-qq-bot/logs/stream?limit=2';
		const response = createLogStreamResponse(service, makeRequest(url, controller.signal), { heartbeatMs: 100000 });
		const reader = response.body!.getReader();
		expect(snapshotEntries(await readFrame(reader)).map((entry) => entry.text)).toEqual(['m4', 'm5']);

		// 非法 limit 回落默认（300）：全部 5 条都在。
		const fallback = createLogStreamResponse(
			service,
			makeRequest('http://127.0.0.1:3080/api/dsh-qq-bot/logs/stream?limit=abc', controller.signal),
			{ heartbeatMs: 100000 },
		);
		expect(snapshotEntries(await readFrame(fallback.body!.getReader()))).toHaveLength(5);
		controller.abort();
	});

	it('signal 中止后停止订阅并关闭流', async () => {
		const service = makeService();
		const controller = new AbortController();
		const response = createLogStreamResponse(service, makeRequest(undefined, controller.signal), { heartbeatMs: 100000 });
		const reader = response.body!.getReader();
		expect(snapshotEntries(await readFrame(reader))).toEqual([]);

		controller.abort();
		expect(await readFrame(reader)).toBeNull();
		// 订阅已解除：再记录既不抛错也不会写进已关闭的流。
		expect(() => {
			service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'after-abort' });
		}).not.toThrow();
	});

	it('客户端严重落后时丢帧，追上后补发 resync', async () => {
		const service = makeService();
		const controller = new AbortController();
		const response = createLogStreamResponse(service, makeRequest(undefined, controller.signal), {
			heartbeatMs: 15,
			overflowChunks: 4,
		});
		const reader = response.body!.getReader();
		// 故意不读：队列堆过阈值后开始丢帧。
		for (let i = 1; i <= 20; i++) {
			service.record({ dir: 'in', scope: 'onebot', event: 'message', text: `m${i}` });
		}
		const frames: LogStreamFrame[] = [];
		for (;;) {
			const frame = await readFrame(reader, 300);
			if (frame === undefined || frame === null) break;
			frames.push(frame);
		}
		const appends = frames.filter((frame) => frame.kind === 'append');
		expect(appends.length).toBeGreaterThan(0);
		expect(appends.length).toBeLessThan(20);
		expect(frames.some((frame) => frame.kind === 'resync')).toBe(true);
		controller.abort();
	});
});

describe('normalizeLogStreamLimit / encodeSseFrame', () => {
	it('校验非法值与边界', () => {
		expect(normalizeLogStreamLimit('50')).toBe(50);
		expect(normalizeLogStreamLimit('0')).toBe(1);
		expect(normalizeLogStreamLimit('99999')).toBe(1000);
		expect(normalizeLogStreamLimit(undefined)).toBe(300);
		expect(normalizeLogStreamLimit('abc')).toBe(300);
	});

	it('帧格式为 data: + 空行（JSON）', () => {
		expect(encodeSseFrame({ kind: 'clear' })).toBe('data: {"kind":"clear"}\n\n');
	});
});
