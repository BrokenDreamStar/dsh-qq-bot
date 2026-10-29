/** 无进展看门狗：判据是"事件流不动"，不是"跑了多久"。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStallGuard, describeStallMs } from './stall.ts';

describe('describeStallMs（提示文案用的时长）', () => {
	it('整分钟不带小数，不足一分钟用秒', () => {
		expect(describeStallMs(900_000)).toBe('15 分钟');
		expect(describeStallMs(60_000)).toBe('1 分钟');
		expect(describeStallMs(45_000)).toBe('45 秒');
		expect(describeStallMs(0)).toBe('1 秒');
	});

	it('非整分钟按分钟四舍五入', () => {
		expect(describeStallMs(90_000)).toBe('2 分钟');
	});
});

describe('createStallGuard（无进展看门狗）', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('idleMs <= 0 = 不监视：再久也不触发', async () => {
		const guard = createStallGuard({ idleMs: 0, progress: () => 0 });
		await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
		expect(guard.isStalled).toBe(false);
		guard.stop();
	});

	it('连续无进展到点即判定（默认 15 分钟）', async () => {
		const guard = createStallGuard({ idleMs: 900_000, progress: () => 5 });
		await vi.advanceTimersByTimeAsync(895_000);
		expect(guard.isStalled).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(guard.isStalled).toBe(true);
		await expect(guard.stalled).resolves.toBeUndefined();
		guard.stop();
	});

	it('只要还在推进就永不触发（长任务跑 3 小时也不算卡死）', async () => {
		let seq = 0;
		const heartbeat = setInterval(() => {
			seq += 1;
		}, 1_000);
		const guard = createStallGuard({ idleMs: 60_000, progress: () => seq });
		await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
		expect(guard.isStalled).toBe(false);
		clearInterval(heartbeat);
		guard.stop();
	});

	it('等用户回答期间不计时（等人 ≠ 卡死）', async () => {
		let waiting = true;
		const guard = createStallGuard({ idleMs: 60_000, progress: () => 0, waiting: () => waiting });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(guard.isStalled).toBe(false);
		waiting = false;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(guard.isStalled).toBe(false);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(guard.isStalled).toBe(true);
		guard.stop();
	});

	it('stop() 之后不再触发（本轮已正常结束）', async () => {
		const guard = createStallGuard({ idleMs: 10_000, progress: () => 0 });
		guard.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(guard.isStalled).toBe(false);
	});

	it('轮询间隔被压到 idleMs/4 以内：idleMs 小也不会拖到 pollMs 才判定', async () => {
		const guard = createStallGuard({ idleMs: 20_000, pollMs: 60_000, progress: () => 0 });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(guard.isStalled).toBe(true);
		guard.stop();
	});
});
