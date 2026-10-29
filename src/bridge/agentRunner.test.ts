/** agentRunner：会话日志读取的 dsh 版本兼容层 + 轮次汇总。 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { readSessionEvents, runTurn, summarizeTurn, tokenUsage } from './agentRunner.ts';
import type { Agent, SessionStore } from '../dsh.ts';

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

/**
 * 假 agent：whenIdle 由外部释放（`finish()` 或 cancel 触发），
 * 与 dsh 一致——cancel 之后 agent 立刻变空闲（下一次 whenIdle 直接 resolve）。
 */
function makeAgent(options: { progress?: () => number } = {}) {
	const cancels: unknown[] = [];
	const followups: unknown[] = [];
	const pending: Array<() => void> = [];
	let canceled = false;
	const agent = {
		session: {
			get seq(): number {
				return options.progress?.() ?? 0;
			},
			snapshotEvents: () => [],
		},
		followup: (message: unknown) => {
			followups.push(message);
		},
		whenIdle: () => (canceled ? Promise.resolve() : new Promise<void>((resolve) => pending.push(resolve))),
		cancel: (cause: unknown) => {
			cancels.push(cause);
			canceled = true;
			for (const resolve of pending.splice(0)) resolve();
		},
	} as unknown as Agent;
	const sessions = { flush: async () => undefined } as unknown as SessionStore;
	return {
		agent,
		sessions,
		cancels,
		followups,
		/** agent 自己跑完（正常收尾）。 */
		finish(): void {
			for (const resolve of pending.splice(0)) resolve();
		},
	};
}

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

describe('runTurn：没有总时长超时，只有无进展看门狗', () => {
	it('没配 idleTimeoutMs（= 0）时，whenIdle 迟迟不结束也不会被腰斩', async () => {
		vi.useFakeTimers();
		try {
			let release: (() => void) | undefined;
			const idle = new Promise<void>((resolve) => {
				release = resolve;
			});
			const followups: unknown[] = [];
			const agent = {
				session: { seq: 0, snapshotEvents: () => [] },
				followup: (message: unknown) => {
					followups.push(message);
				},
				whenIdle: () => idle,
			} as unknown as Agent;
			const sessions = { flush: async () => undefined } as unknown as SessionStore;

			let settled = false;
			const promise = runTurn({ agent, sessions, promptText: '在吗' }).then((outcome) => {
				settled = true;
				return outcome;
			});
			// 曾经的 maxTurnMs（默认 10 分钟）会在这里把这一轮 cancel 掉并提前返回。
			await vi.advanceTimersByTimeAsync(3_600_000);
			expect(followups).toHaveLength(1);
			expect(settled).toBe(false);

			release?.();
			await expect(promise).resolves.toEqual({ text: '', endReason: undefined, stalled: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it('连续无进展到点：取消本轮并如实返回 stalled', async () => {
		vi.useFakeTimers();
		try {
			const fake = makeAgent();
			const promise = runTurn({ agent: fake.agent, sessions: fake.sessions, promptText: '跑个长任务', idleTimeoutMs: 60_000 });
			await vi.advanceTimersByTimeAsync(30_000);
			expect(fake.cancels).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(40_000);
			const outcome = await promise;
			expect(outcome.stalled).toBe(true);
			expect(fake.cancels).toEqual([{ kind: 'hook', reason: 'dsh-qq-bot stall watchdog' }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('seq 一直推进就永不判定：长任务跑 3 小时也不打断', async () => {
		vi.useFakeTimers();
		try {
			let seq = 0;
			const fake = makeAgent({ progress: () => seq });
			const heartbeat = setInterval(() => {
				seq += 1;
			}, 1_000);
			const promise = runTurn({ agent: fake.agent, sessions: fake.sessions, promptText: '很长的任务', idleTimeoutMs: 60_000 });
			await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
			expect(fake.cancels).toHaveLength(0);
			clearInterval(heartbeat);
			fake.finish();
			await expect(promise).resolves.toMatchObject({ stalled: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it('等用户回答期间不计入无进展（等人 ≠ 卡死）', async () => {
		vi.useFakeTimers();
		try {
			let waiting = true;
			const fake = makeAgent();
			const promise = runTurn({
				agent: fake.agent,
				sessions: fake.sessions,
				promptText: '问用户一个问题',
				idleTimeoutMs: 60_000,
				waitingForAnswer: () => waiting,
			});
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(fake.cancels).toHaveLength(0);
			waiting = false;
			await vi.advanceTimersByTimeAsync(150_000);
			await expect(promise).resolves.toMatchObject({ stalled: true });
			expect(fake.cancels).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
