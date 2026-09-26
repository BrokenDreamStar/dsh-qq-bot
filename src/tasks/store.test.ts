import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_TASKS, TaskStore, validateTaskInput } from './store.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeStore(): TaskStore {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), 'dshqq-tasks-')), logger);
	store.init();
	return store;
}

const baseInput = {
	chatKey: 'u-10001',
	chatType: 'private' as const,
	chatId: '10001',
	prompt: '提醒我喝水',
	schedule: { kind: 'daily' as const, time: '09:00' },
};

describe('validateTaskInput', () => {
	it('校验各字段并剥离备注空白', () => {
		const parsed = validateTaskInput({ ...baseInput, prompt: '  提醒我喝水  ', note: ' 提醒 ', kind: 'daily', time: '09:00' });
		expect('error' in parsed).toBe(false);
		if (!('error' in parsed)) {
			expect(parsed.prompt).toBe('提醒我喝水');
			expect(parsed.note).toBe('提醒');
		}
	});

	it('拒绝空 prompt / 非法号码 / 非法时间表 / 超长备注', () => {
		expect(validateTaskInput({ ...baseInput, prompt: '   ', kind: 'daily', time: '09:00' })).toHaveProperty('error');
		expect(validateTaskInput({ ...baseInput, chatId: 'abc', kind: 'daily', time: '09:00' })).toHaveProperty('error');
		expect(validateTaskInput({ ...baseInput, kind: 'daily', time: 'xx' })).toHaveProperty('error');
		expect(validateTaskInput({ ...baseInput, kind: 'daily', time: '09:00', note: 'x'.repeat(201) })).toHaveProperty('error');
	});
});

describe('TaskStore', () => {
	it('add 后 onChange 触发并落盘，重启可读回', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dshqq-tasks-'));
		const store = new TaskStore(dir, logger);
		store.init();
		const onChange = vi.fn();
		store.onChange = onChange;
		const added = store.add(baseInput, { total: 10, perChat: 5 });
		if ('error' in added) throw new Error('add 不应失败');
		expect(onChange).toHaveBeenCalledTimes(1);

		const reloaded = new TaskStore(dir, logger);
		reloaded.init();
		expect(reloaded.list().length).toBe(1);
		expect(reloaded.list()[0]?.id).toBe(added.task.id);
		expect(reloaded.list()[0]?.schedule).toEqual({ kind: 'daily', time: '09:00' });
	});

	it('单会话与全库上限', () => {
		const store = makeStore();
		for (let i = 0; i < 3; i += 1) {
			const added = store.add({ ...baseInput, prompt: `任务${i}` }, { total: 10, perChat: 3 });
			expect('error' in added).toBe(false);
		}
		expect(store.add(baseInput, { total: 10, perChat: 3 })).toEqual({ error: '本会话定时任务已达上限（3），请先取消一些' });
		expect(store.add({ ...baseInput, chatKey: 'u-20002', chatId: '20002' }, { total: 3, perChat: 10 })).toEqual({
			error: '定时任务总数已达上限（3），请先清理不用的任务',
		});
	});

	it('remove / setEnabled / markRun / update', () => {
		const store = makeStore();
		const added = store.add(baseInput, { total: 10, perChat: 5 });
		if ('error' in added) throw new Error('add 不应失败');
		const id = added.task.id;

		expect(store.setEnabled(id, false)?.enabled).toBe(false);
		store.markRun(id, 1234);
		expect(store.get(id)?.lastRunAt).toBe(1234);
		expect(store.update(id, { prompt: '新指令', note: '' })?.prompt).toBe('新指令');
		expect(store.get(id)?.note).toBeUndefined();
		expect(store.remove(id)).toBe(true);
		expect(store.get(id)).toBeUndefined();
		expect(store.remove(id)).toBe(false);
	});

	it('损坏的 tasks.json 视为空库；坏条目逐条跳过不拖垮整库', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dshqq-tasks-'));
		const store = new TaskStore(dir, logger);
		store.init();
		const added = store.add(baseInput, { total: 10, perChat: 5 });
		if ('error' in added) throw new Error('add 不应失败');
		const good = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as unknown[];
		writeFileSync(join(dir, 'tasks.json'), JSON.stringify([...good, { id: 't-bad' }, null, 42]), 'utf8');

		const reloaded = new TaskStore(dir, logger);
		reloaded.init();
		expect(reloaded.list().length).toBe(1);
		expect(reloaded.list()[0]?.id).toBe(added.task.id);
	});

	it('JSON 完全损坏时视为空库（不阻塞启动）', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dshqq-tasks-'));
		writeFileSync(join(dir, 'tasks.json'), '{oops', 'utf8');
		const store = new TaskStore(dir, logger);
		store.init();
		expect(store.list().length).toBe(0);
	});

	it('上限常量合理', () => {
		expect(MAX_TASKS).toBe(200);
	});
});
