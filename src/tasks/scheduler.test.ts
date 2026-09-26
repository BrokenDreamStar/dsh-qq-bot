import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from './scheduler.ts';
import { nextRunAt } from './schedule.ts';
import { TaskStore } from './store.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEnv(catchupMs: number) {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), 'dshqq-tasks-sched-')), logger);
	store.init();
	const fired: string[] = [];
	const scheduler = new TaskScheduler({
		store,
		logger,
		catchupMs,
		fire: async (task) => {
			fired.push(task.id);
		},
	});
	return { store, scheduler, fired };
}

/** 冲刷 fireDue 的微任务链（markRun → await fire → 推进）。 */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** 手动驱动一次扫描（等价于 start 后的周期 tick）。 */
function tick(scheduler: TaskScheduler): void {
	(scheduler as unknown as { tick(): void }).tick();
}

/** Date → 'YYYY-MM-DD HH:mm'（本地时间，供 once 任务用）。 */
function formatLocal(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe('TaskScheduler', () => {
	it('refresh 把启用任务排进触发表，停用的不排', () => {
		const { store, scheduler } = makeEnv(30 * 60_000);
		const a = store.add({ chatKey: 'u-1', chatType: 'private', chatId: '1', prompt: 'a', schedule: { kind: 'daily', time: '23:59' } }, { total: 10, perChat: 10 });
		const b = store.add({ chatKey: 'u-2', chatType: 'private', chatId: '2', prompt: 'b', schedule: { kind: 'daily', time: '00:01' } }, { total: 10, perChat: 10 });
		if ('error' in a || 'error' in b) throw new Error('add 不应失败');
		store.setEnabled(b.task.id, false);
		scheduler.refresh();
		expect(scheduler.nextRunOf(a.task.id)).toBeTypeOf('number');
		expect(scheduler.nextRunOf(b.task.id)).toBeUndefined();
	});

	it('tick 触发到期任务；一次性任务触发后自动停用', async () => {
		vi.useFakeTimers();
		try {
			const { store, scheduler, fired } = makeEnv(30 * 60_000);
			// formatLocal 只保留到分钟：+61s 保证截断后的分钟仍在未来。
			const once = store.add(
				{ chatKey: 'u-1', chatType: 'private', chatId: '1', prompt: 'once', schedule: { kind: 'once', runAt: formatLocal(new Date(Date.now() + 61_000)) } },
				{ total: 10, perChat: 10 },
			);
			if ('error' in once) throw new Error('add 不应失败');
			scheduler.refresh();
			expect(scheduler.nextRunOf(once.task.id)).toBeTypeOf('number');

			vi.setSystemTime(Date.now() + 65_000);
			tick(scheduler);
			await flush();
			expect(fired).toEqual([once.task.id]);
			expect(store.get(once.task.id)?.enabled).toBe(false);
			expect(scheduler.nextRunOf(once.task.id)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('循环任务触发后推进到下一周期并记录 lastRunAt', async () => {
		vi.useFakeTimers();
		try {
			const { store, scheduler, fired } = makeEnv(30 * 60_000);
			const daily = store.add({ chatKey: 'u-1', chatType: 'private', chatId: '1', prompt: 'daily', schedule: { kind: 'daily', time: '00:00' } }, { total: 10, perChat: 10 });
			if ('error' in daily) throw new Error('add 不应失败');
			// 把计划点设在昨天 00:00（createdAt 是现在，会排到明天；直接改锚点模拟）
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			yesterday.setHours(0, 0, 0, 0);
			store.get(daily.task.id)!.lastRunAt = yesterday.getTime();
			scheduler.refresh();
			const scheduled = scheduler.nextRunOf(daily.task.id);
			expect(scheduled).toBeTypeOf('number');

			vi.setSystemTime((scheduled ?? 0) + 1000);
			tick(scheduler);
			await flush();
			expect(fired).toEqual([daily.task.id]);
			expect(store.get(daily.task.id)?.lastRunAt).toBe((scheduled ?? 0) + 1000);
			expect(scheduler.nextRunOf(daily.task.id)).toBe(nextRunAt({ kind: 'daily', time: '00:00' }, (scheduled ?? 0) + 1000));
			expect(store.get(daily.task.id)?.enabled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('错过触发点但在宽限期内 → 补发一次', async () => {
		vi.useFakeTimers();
		try {
			const { store, scheduler, fired } = makeEnv(30 * 60_000);
			const task = store.add({ chatKey: 'u-1', chatType: 'private', chatId: '1', prompt: 'catchup', schedule: { kind: 'daily', time: '09:00' } }, { total: 10, perChat: 10 });
			if ('error' in task) throw new Error('add 不应失败');
			// 模拟停机 20 分钟：计划点 09:00 已过，lastRunAt 停在 08:50（锚点）
			const now = new Date();
			now.setHours(9, 10, 0, 0);
			vi.setSystemTime(now.getTime());
			store.get(task.task.id)!.lastRunAt = now.getTime() - 20 * 60_000;
			scheduler.refresh();

			tick(scheduler);
			await flush();
			expect(fired).toEqual([task.task.id]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('错过触发点超过宽限期 → 跳过不补发，推进到下一周期', async () => {
		vi.useFakeTimers();
		try {
			const { store, scheduler, fired } = makeEnv(30 * 60_000);
			const task = store.add({ chatKey: 'u-1', chatType: 'private', chatId: '1', prompt: 'stale', schedule: { kind: 'daily', time: '09:00' } }, { total: 10, perChat: 10 });
			if ('error' in task) throw new Error('add 不应失败');
			const now = new Date();
			now.setHours(15, 0, 0, 0); // 计划点 09:00 已过 6 小时
			vi.setSystemTime(now.getTime());
			// 锚点在今天 08:00（计划点之前），refresh 才会排出"今天 09:00"这个已过期的触发点
			const anchor = new Date(now);
			anchor.setHours(8, 0, 0, 0);
			store.get(task.task.id)!.lastRunAt = anchor.getTime();
			scheduler.refresh();
			expect(scheduler.nextRunOf(task.task.id)).toBe(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0).getTime());

			tick(scheduler);
			await flush();
			expect(fired).toEqual([]);
			const tomorrow = new Date(now);
			tomorrow.setDate(tomorrow.getDate() + 1);
			tomorrow.setHours(9, 0, 0, 0);
			expect(scheduler.nextRunOf(task.task.id)).toBe(tomorrow.getTime());
		} finally {
			vi.useRealTimers();
		}
	});
});
