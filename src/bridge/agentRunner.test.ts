/** agentRunner：会话日志读取的 dsh 版本兼容层 + 轮次汇总。 */
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { readSessionEvents, summarizeTurn, tokenUsage } from './agentRunner.ts';
import type { Agent } from '../dsh.ts';

function ev(seq: number, type: string, data: unknown): SessionEvent {
	return { seq, type, data } as unknown as SessionEvent;
}

/** 一轮完整对话：turn/start → assistant/message → turn/end。 */
const log: SessionEvent[] = [
	ev(0, 'turn/start', { turn: 1 }),
	ev(1, 'assistant/message', {
		message: { content: [{ type: 'text', text: '你好' }] },
		usage: { inputTokens: 10, outputTokens: 3 },
	}),
	ev(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];

describe('readSessionEvents（dsh 版本兼容）', () => {
	it('新版 dsh：优先 snapshotEvents()', () => {
		let calls = 0;
		const session = {
			snapshotEvents: () => {
				calls += 1;
				return log;
			},
			events: [],
		};
		expect(readSessionEvents(session)).toBe(log);
		expect(calls).toBe(1);
	});

	it('旧版 dsh：回退 events 访问器', () => {
		expect(readSessionEvents({ events: log })).toBe(log);
	});

	it('两版 API 都缺失时抛出可诊断错误', () => {
		expect(() => readSessionEvents({})).toThrow(/snapshotEvents/);
	});
});

describe('summarizeTurn / tokenUsage 走兼容层', () => {
	it('从 snapshotEvents-only 会话汇总回复与结束原因', () => {
		const { text, endReason } = summarizeTurn(readSessionEvents({ snapshotEvents: () => log }), 0);
		expect(text).toBe('你好');
		expect(endReason).toEqual({ kind: 'completed' });
	});

	it('只统计 firstSeq 之后的事件', () => {
		const { text, endReason } = summarizeTurn(readSessionEvents({ snapshotEvents: () => log }), 2);
		expect(text).toBe('');
		expect(endReason).toBeUndefined();
	});

	it('tokenUsage 从 snapshotEvents-only 会话累计用量', () => {
		const agent = { session: { snapshotEvents: () => log } } as unknown as Agent;
		expect(tokenUsage(agent)).toEqual({ input: 10, output: 3 });
	});
});
