import { describe, expect, it } from 'vitest';
import {
	BUSY_STRATEGIES,
	DEFAULT_BUSY_STRATEGY,
	HELD_NOTICE,
	HELD_ROTATED_NOTICE,
	describeDisposition,
	handleDisposition,
	normalizeBusyStrategy,
	shouldEvictIdleSessions,
	waitForHandleRelease,
} from './reclaim.ts';

describe('busy 策略', () => {
	it('默认是等待（等待只损失时延，轮换会丢上下文）', () => {
		expect(DEFAULT_BUSY_STRATEGY).toBe('wait');
		expect(BUSY_STRATEGIES).toContain('wait');
		expect(BUSY_STRATEGIES).toContain('rotate');
	});

	it('未知取值回落到等待', () => {
		expect(normalizeBusyStrategy('rotate')).toBe('rotate');
		expect(normalizeBusyStrategy('wait')).toBe('wait');
		expect(normalizeBusyStrategy(undefined)).toBe('wait');
		expect(normalizeBusyStrategy('')).toBe('wait');
		expect(normalizeBusyStrategy(true)).toBe('wait');
	});

	it('sessionIdleTimeoutMs=0 → 插件会话永不回收', () => {
		expect(shouldEvictIdleSessions(0)).toBe(false);
		expect(shouldEvictIdleSessions(-1)).toBe(false);
		expect(shouldEvictIdleSessions(1_800_000)).toBe(true);
	});

	it('提示文案区分「正在等」与「已经换新会话」', () => {
		expect(HELD_NOTICE).toContain('等');
		expect(HELD_ROTATED_NOTICE).toContain('新会话');
		expect(HELD_NOTICE).not.toBe(HELD_ROTATED_NOTICE);
	});
});

describe('写句柄归属', () => {
	it('本桥持有优先于宿主有活 agent（同一实例）', () => {
		expect(handleDisposition({ hasLocalHandle: true, hostHasLiveAgent: true })).toBe('ours');
	});

	it('本桥没有 handle 时，宿主有活 agent = 其它界面持有', () => {
		expect(handleDisposition({ hasLocalHandle: false, hostHasLiveAgent: true })).toBe('other');
		expect(handleDisposition({ hasLocalHandle: false, hostHasLiveAgent: false })).toBe('none');
	});

	it('三种状态各有说明文案', () => {
		for (const disposition of ['ours', 'other', 'none'] as const) {
			expect(describeDisposition(disposition).length).toBeGreaterThan(0);
		}
		expect(describeDisposition('other')).toContain('其它界面');
	});
});

describe('waitForHandleRelease', () => {
	/** 假时钟：sleep 只推进 now()，不真的等。 */
	function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
		let current = 0;
		const slept: number[] = [];
		return {
			now: () => current,
			sleep: async (ms: number) => {
				slept.push(ms);
				current += ms;
			},
			slept,
		};
	}

	it('第一次探测就成功时只调用一次 release', async () => {
		const clock = fakeClock();
		let calls = 0;
		const result = await waitForHandleRelease(
			async () => {
				calls += 1;
				return true;
			},
			{ deadlineMs: 1_000, now: clock.now, sleep: clock.sleep },
		);
		expect(result).toBe('released');
		expect(calls).toBe(1);
		expect(clock.slept).toEqual([]);
	});

	it('先按短退避探测，再转入稳定轮询，超时返回 deadline', async () => {
		const clock = fakeClock();
		let calls = 0;
		const result = await waitForHandleRelease(
			async () => {
				calls += 1;
				return false;
			},
			{ deadlineMs: 10_000, now: clock.now, sleep: clock.sleep, probeDelaysMs: [200, 400], pollMs: 5_000 },
		);
		expect(result).toBe('deadline');
		// 200 + 400 两次短退避，其后按 5000 轮询；最后一次被剩余预算截断。
		expect(clock.slept).toEqual([200, 400, 5_000, 4_400]);
		expect(clock.now()).toBe(10_000);
		expect(calls).toBe(5);
	});

	it('探测抛错视为"仍未释放"，不中断等待', async () => {
		const clock = fakeClock();
		let calls = 0;
		const result = await waitForHandleRelease(
			async () => {
				calls += 1;
				if (calls < 3) throw new Error('session is already owned by an active write handle');
				return true;
			},
			{ deadlineMs: 5_000, now: clock.now, sleep: clock.sleep, probeDelaysMs: [1, 1], pollMs: 1 },
		);
		expect(result).toBe('released');
		expect(calls).toBe(3);
	});

	it('isCanceled 为真时立刻返回 canceled（/reset、/reclaim 打断等待）', async () => {
		const clock = fakeClock();
		let calls = 0;
		let canceled = false;
		const result = await waitForHandleRelease(
			async () => {
				calls += 1;
				canceled = true; // 第一轮之后请求接管
				return false;
			},
			{ deadlineMs: 60_000, now: clock.now, sleep: clock.sleep, pollMs: 5_000, isCanceled: () => canceled },
		);
		expect(result).toBe('canceled');
		expect(calls).toBe(1);
		expect(clock.slept).toEqual([]);
	});

	it('进入前就已取消则不探测', async () => {
		const clock = fakeClock();
		let calls = 0;
		const result = await waitForHandleRelease(
			async () => {
				calls += 1;
				return true;
			},
			{ deadlineMs: 1_000, now: clock.now, sleep: clock.sleep, isCanceled: () => true },
		);
		expect(result).toBe('canceled');
		expect(calls).toBe(0);
	});
});
