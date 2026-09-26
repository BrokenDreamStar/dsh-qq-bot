import { describe, expect, it } from 'vitest';
import { describeSchedule, nextRunAt, nextRunForTask, normalizeRunAtInput, normalizeTaskSchedule, normalizeTimeInput, normalizeWeekdaysInput, runAtToMs } from './schedule.ts';

describe('normalizeTimeInput', () => {
	it('规范 HH:mm 并补零', () => {
		expect(normalizeTimeInput('9')).toBe('09:00');
		expect(normalizeTimeInput('9:5')).toBe('09:05');
		expect(normalizeTimeInput('23:59:01')).toBe('23:59');
		expect(normalizeTimeInput(' 08:30 ')).toBe('08:30');
	});

	it('拒绝非法时间', () => {
		expect(normalizeTimeInput('24:00')).toBeNull();
		expect(normalizeTimeInput('9:60')).toBeNull();
		expect(normalizeTimeInput('abc')).toBeNull();
		expect(normalizeTimeInput('')).toBeNull();
		expect(normalizeTimeInput(9)).toBeNull();
	});
});

describe('normalizeRunAtInput', () => {
	it('接受空格与 T 分隔并规范为本地时间', () => {
		expect(normalizeRunAtInput('2026-09-14 09:05')).toBe('2026-09-14 09:05');
		expect(normalizeRunAtInput('2026-09-14T09:05:00')).toBe('2026-09-14 09:05');
	});

	it('拒绝不存在的日期与非法格式', () => {
		expect(normalizeRunAtInput('2026-02-30 09:00')).toBeNull();
		expect(normalizeRunAtInput('2026-13-01 09:00')).toBeNull();
		expect(normalizeRunAtInput('2026-09-14')).toBeNull();
		expect(normalizeRunAtInput('明天早上九点')).toBeNull();
	});
});

describe('normalizeWeekdaysInput', () => {
	it('去重、排序、容忍字符串数字', () => {
		expect(normalizeWeekdaysInput([5, '1', 3, 5])).toEqual([1, 3, 5]);
	});

	it('拒绝空表与越界值', () => {
		expect(normalizeWeekdaysInput([])).toBeNull();
		expect(normalizeWeekdaysInput([7])).toBeNull();
		expect(normalizeWeekdaysInput([-1])).toBeNull();
		expect(normalizeWeekdaysInput(['mon'])).toBeNull();
	});
});

describe('normalizeTaskSchedule', () => {
	it('按 kind 校验各字段', () => {
		expect(normalizeTaskSchedule({ kind: 'daily', time: '9' })).toEqual({ schedule: { kind: 'daily', time: '09:00' } });
		expect(normalizeTaskSchedule({ kind: 'weekly', time: '08:00', weekdays: [1, 5] })).toEqual({ schedule: { kind: 'weekly', time: '08:00', weekdays: [1, 5] } });
		expect(normalizeTaskSchedule({ kind: 'once', runAt: '2026-09-14 09:00' })).toEqual({ schedule: { kind: 'once', runAt: '2026-09-14 09:00' } });
	});

	it('非法输入返回错误文案', () => {
		expect(normalizeTaskSchedule({ kind: 'daily', time: '25:00' })).toHaveProperty('error');
		expect(normalizeTaskSchedule({ kind: 'weekly', time: '08:00' })).toHaveProperty('error');
		expect(normalizeTaskSchedule({ kind: 'hourly' })).toHaveProperty('error');
		expect(normalizeTaskSchedule(undefined)).toHaveProperty('error');
	});
});

describe('nextRunAt', () => {
	it('daily：今天未过给今天，已过给明天', () => {
		const base = new Date(2026, 8, 13, 8, 0).getTime(); // 2026-09-13 08:00 周日
		const today = nextRunAt({ kind: 'daily', time: '09:00' }, base);
		expect(today).toBe(new Date(2026, 8, 13, 9, 0).getTime());
		const after = new Date(2026, 8, 13, 9, 0, 30).getTime();
		const tomorrow = nextRunAt({ kind: 'daily', time: '09:00' }, after);
		expect(tomorrow).toBe(new Date(2026, 8, 14, 9, 0).getTime());
	});

	it('weekly：取最近的一个所选星期', () => {
		// 2026-09-13 是周日
		const base = new Date(2026, 8, 13, 10, 0).getTime();
		const next = nextRunAt({ kind: 'weekly', time: '08:30', weekdays: [1, 3] }, base);
		expect(next).toBe(new Date(2026, 8, 14, 8, 30).getTime()); // 周一
		const friday = nextRunAt({ kind: 'weekly', time: '08:30', weekdays: [5] }, base);
		expect(friday).toBe(new Date(2026, 8, 18, 8, 30).getTime());
	});

	it('weekly：今天刚过触发点则跳到下周同一天', () => {
		const base = new Date(2026, 8, 13, 9, 0).getTime(); // 周日 09:00，08:30 已过
		const next = nextRunAt({ kind: 'weekly', time: '08:30', weekdays: [0] }, base);
		expect(next).toBe(new Date(2026, 8, 20, 8, 30).getTime());
	});

	it('once：未到给触发点，已过为 null', () => {
		const at = new Date(2026, 8, 14, 9, 0).getTime();
		expect(nextRunAt({ kind: 'once', runAt: '2026-09-14 09:00' }, at - 1)).toBe(at);
		expect(nextRunAt({ kind: 'once', runAt: '2026-09-14 09:00' }, at)).toBeNull();
	});

	it('非法时间表返回 null（防御 revive 的脏数据）', () => {
		expect(nextRunAt({ kind: 'daily', time: 'xx' }, Date.now())).toBeNull();
		// @ts-expect-error 构造非法形状验证运行时兜底
		expect(nextRunAt({ kind: 'weekly', time: '08:00', weekdays: [] }, Date.now())).toBeNull();
	});
});

describe('runAtToMs / describeSchedule / nextRunForTask', () => {
	it('runAtToMs 按本地时区解析', () => {
		expect(runAtToMs('2026-09-14 09:05')).toBe(new Date(2026, 8, 14, 9, 5).getTime());
		expect(runAtToMs('垃圾')).toBeNull();
	});

	it('describeSchedule 输出人类可读文案', () => {
		expect(describeSchedule({ kind: 'daily', time: '09:05' })).toBe('每天 09:05');
		expect(describeSchedule({ kind: 'weekly', time: '08:00', weekdays: [1, 3, 5] })).toBe('每周一、三、五 08:00');
		expect(describeSchedule({ kind: 'once', runAt: '2026-09-14 09:00' })).toBe('2026-09-14 09:00（一次性）');
	});

	it('nextRunForTask 的锚点是 lastRunAt ?? createdAt', () => {
		const created = new Date(2026, 8, 12, 22, 0).getTime();
		const ran = new Date(2026, 8, 13, 9, 0).getTime();
		expect(nextRunForTask({ schedule: { kind: 'daily', time: '09:00' }, createdAt: created, lastRunAt: ran })).toBe(
			new Date(2026, 8, 14, 9, 0).getTime(),
		);
		expect(nextRunForTask({ schedule: { kind: 'daily', time: '09:00' }, createdAt: created })).toBe(new Date(2026, 8, 13, 9, 0).getTime());
	});
});
