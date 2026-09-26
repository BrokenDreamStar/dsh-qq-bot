import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleTaskRpc, type TaskRpcDeps } from './rpc.ts';
import { TaskStore } from './store.ts';
import type { ScheduledTask } from './store.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeDeps(overrides?: Partial<TaskRpcDeps>): { deps: TaskRpcDeps; store: TaskStore } {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), 'dshqq-tasksrpc-')), logger);
	store.init();
	const deps: TaskRpcDeps = {
		store,
		nextRunOf: () => undefined,
		perChatLimit: () => 5,
		runTask: () => {},
		logger,
		...overrides,
	};
	return { deps, store };
}

const upsertBody = {
	chat: 'friend_10001',
	prompt: '提醒我起床',
	note: '起床',
	kind: 'daily',
	time: '07:30',
};

describe('handleTaskRpc', () => {
	it('tasks/upsert 新建 → tasks/list 回显', async () => {
		const { deps } = makeDeps();
		const created = await handleTaskRpc('tasks/upsert', upsertBody, deps);
		expect(created?.ok).toBe(true);
		if (!created?.ok) return;
		const list = await handleTaskRpc('tasks/list', {}, deps);
		expect(list?.ok).toBe(true);
		if (!list?.ok) return;
		const tasks = (list.value as { tasks: Array<Record<string, unknown>> }).tasks;
		expect(tasks.length).toBe(1);
		expect(tasks[0]).toMatchObject({ chat: 'friend_10001', chatKey: 'u-10001', chatId: '10001', chatType: 'private', kind: 'daily', time: '07:30', note: '起床', enabled: true });
		expect(tasks[0]?.id).toMatch(/^t-/);
	});

	it('tasks/upsert 更新已有任务（换时间、换会话）', async () => {
		const { deps } = makeDeps();
		const created = await handleTaskRpc('tasks/upsert', upsertBody, deps);
		if (!created?.ok) throw new Error('创建失败');
		const id = (created.value as { id: string }).id;
		const updated = await handleTaskRpc('tasks/upsert', { ...upsertBody, id, kind: 'weekly', time: '08:00', weekdays: [1, 5], chat: 'group_123456' }, deps);
		expect(updated?.ok).toBe(true);
		const task = deps.store.get(id);
		expect(task?.schedule).toEqual({ kind: 'weekly', time: '08:00', weekdays: [1, 5] });
		expect(task?.chatKey).toBe('g-123456');
		expect(task?.chatId).toBe('123456');
	});

	it('upsert 校验：非法会话/非法时间/未知任务 id', async () => {
		const { deps } = makeDeps();
		expect((await handleTaskRpc('tasks/upsert', { ...upsertBody, chat: 'wechat_1' }, deps))?.ok).toBe(false);
		expect((await handleTaskRpc('tasks/upsert', { ...upsertBody, time: '25:00' }, deps))?.ok).toBe(false);
		expect((await handleTaskRpc('tasks/upsert', { ...upsertBody, kind: 'once' }, deps))?.ok).toBe(false);
		const badId = await handleTaskRpc('tasks/upsert', { ...upsertBody, id: 't-nope' }, deps);
		expect(badId?.ok).toBe(false);
		if (!badId?.ok) expect(badId.error.code).toBe('not-found');
	});

	it('单会话上限生效（perChatLimit）', async () => {
		const { deps } = makeDeps({ perChatLimit: () => 1 });
		expect((await handleTaskRpc('tasks/upsert', upsertBody, deps))?.ok).toBe(true);
		const second = await handleTaskRpc('tasks/upsert', upsertBody, deps);
		expect(second?.ok).toBe(false);
		if (!second?.ok) expect(second.error.code).toBe('limit');
	});

	it('tasks/delete 与 tasks/toggle', async () => {
		const { deps } = makeDeps();
		const created = await handleTaskRpc('tasks/upsert', upsertBody, deps);
		if (!created?.ok) throw new Error('创建失败');
		const id = (created.value as { id: string }).id;

		const toggled = await handleTaskRpc('tasks/toggle', { id, enabled: false }, deps);
		expect(toggled?.ok).toBe(true);
		expect(deps.store.get(id)?.enabled).toBe(false);
		expect((await handleTaskRpc('tasks/toggle', { id: 't-x', enabled: true }, deps))?.ok).toBe(false);

		expect((await handleTaskRpc('tasks/delete', { id }, deps))?.ok).toBe(true);
		expect(deps.store.get(id)).toBeUndefined();
		expect((await handleTaskRpc('tasks/delete', { id }, deps))?.ok).toBe(false);
	});

	it('tasks/run 调用 runTask 且不改 lastRunAt', async () => {
		const { deps } = makeDeps();
		const created = await handleTaskRpc('tasks/upsert', upsertBody, deps);
		if (!created?.ok) throw new Error('创建失败');
		const id = (created.value as { id: string }).id;
		const runTask = vi.fn();
		deps.runTask = runTask;
		const answer = await handleTaskRpc('tasks/run', { id }, deps);
		expect(answer?.ok).toBe(true);
		expect(runTask).toHaveBeenCalledTimes(1);
		expect((runTask.mock.calls[0]?.[0] as ScheduledTask).id).toBe(id);
		expect(deps.store.get(id)?.lastRunAt).toBeUndefined();
	});

	it('无关端点返回 undefined', async () => {
		const { deps } = makeDeps();
		expect(await handleTaskRpc('personas/list', {}, deps)).toBeUndefined();
		expect(await handleTaskRpc('logs/recent', {}, deps)).toBeUndefined();
	});
});
