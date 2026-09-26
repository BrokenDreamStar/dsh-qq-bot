/** MessageLogService：环形缓冲、截断、过滤、热应用与 NDJSON 落盘。 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLogService, type MessageLogEntry } from './store.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeService(dataDir: string, max = 500): MessageLogService {
	const service = new MessageLogService({ logger, dataDir });
	service.reconfigure({ messageLog: true, messageLogMax: max, messageLogToFile: false });
	return service;
}

describe('MessageLogService', () => {
	it('按序记录并保留最新 maxEntries 条（环形裁剪）', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused', 3);
		for (let i = 1; i <= 5; i++) {
			service.record({ dir: 'in', scope: 'onebot', event: 'message', text: `m${i}` });
		}
		const entries = service.recent();
		expect(entries.map((entry) => entry.text)).toEqual(['m3', 'm4', 'm5']);
		expect(entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
		expect(service.size).toBe(3);
	});

	it('seq 与 ts 自动填充且单调', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		service.record({ dir: 'out', scope: 'dsh', event: 'reply', text: 'a' });
		service.record({ dir: 'out', scope: 'dsh', event: 'reply', text: 'b' });
		const [first, second] = service.recent();
		expect(first!.seq).toBe(1);
		expect(second!.seq).toBe(2);
		expect(second!.ts).toBeGreaterThanOrEqual(first!.ts);
	});

	it('超长文本截断到 2000 字符', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'x'.repeat(3000) });
		const entry = service.recent()[0]!;
		expect(entry.text.length).toBe(2001);
		expect(entry.text.endsWith('…')).toBe(true);
	});

	it('recent 支持 limit / chatId / dir 过滤且返回旧→新', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		service.record({ dir: 'in', scope: 'onebot', event: 'message', chatId: '111', text: 'a' });
		service.record({ dir: 'out', scope: 'onebot', event: 'send', chatId: '222', text: 'b' });
		service.record({ dir: 'in', scope: 'onebot', event: 'message', chatId: '111', text: 'c' });
		expect(service.recent({ chatId: '111' }).map((entry) => entry.text)).toEqual(['a', 'c']);
		expect(service.recent({ dir: 'out' }).map((entry) => entry.text)).toEqual(['b']);
		expect(service.recent({ limit: 2 }).map((entry) => entry.text)).toEqual(['b', 'c']);
	});

	it('enabled=false 时丢弃记录；reconfigure 可改上限并裁剪', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		service.reconfigure({ messageLog: false, messageLogMax: 500, messageLogToFile: false });
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'dropped' });
		expect(service.size).toBe(0);
		service.reconfigure({ messageLog: true, messageLogMax: 1, messageLogToFile: false });
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'kept' });
		expect(service.recent().map((entry) => entry.text)).toEqual(['kept']);
	});

	it('clear 清空内存缓冲', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'x' });
		service.clear();
		expect(service.size).toBe(0);
	});

	it('subscribe 收到 append / clear，退订后不再收到', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		const seen: string[] = [];
		const off = service.subscribe((event) => {
			seen.push(event.kind === 'append' ? `append:${event.entry.text}` : event.kind);
		});
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'a' });
		service.clear();
		off();
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'b' });
		expect(seen).toEqual(['append:a', 'clear']);
	});

	it('enabled=false 时不派发订阅事件', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		const seen: string[] = [];
		service.subscribe((event) => {
			seen.push(event.kind);
		});
		service.reconfigure({ messageLog: false, messageLogMax: 500, messageLogToFile: false });
		service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'dropped' });
		expect(seen).toEqual([]);
	});

	it('订阅者抛错不影响 record 主链路', () => {
		const service = makeService('/tmp/dsh-qq-log-test-unused');
		service.subscribe(() => {
			throw new Error('boom');
		});
		expect(() => {
			service.record({ dir: 'in', scope: 'onebot', event: 'message', text: 'x' });
		}).not.toThrow();
		expect(service.size).toBe(1);
	});

	it('messageLogToFile 落盘 NDJSON 且每行一条 JSON', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'dsh-qq-log-'));
		try {
			const service = new MessageLogService({ logger, dataDir });
			service.reconfigure({ messageLog: true, messageLogMax: 10, messageLogToFile: true });
			service.record({ dir: 'in', scope: 'onebot', event: 'message', chatId: '42', text: '你好' });
			// appendFile 是异步的，而且**先建文件、后写内容**：Linux 上 open 会立刻建出
			// 0 字节文件，只等 existsSync 就会在还是空文件时去 JSON.parse('')（真实踩到：
			// WSL2 上稳定失败，macOS 上侥幸通过）。所以等到文件非空为止。
			const path = join(dataDir, 'message-log.ndjson');
			for (let i = 0; i < 100; i++) {
				if (existsSync(path) && readFileSync(path, 'utf8').trim() !== '') break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const lines = readFileSync(path, 'utf8').trim().split('\n');
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(lines[0]!) as MessageLogEntry;
			expect(parsed.text).toBe('你好');
			expect(parsed.chatId).toBe('42');
			expect(parsed.seq).toBe(1);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
