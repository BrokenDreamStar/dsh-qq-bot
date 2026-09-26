/**
 * 定时任务的宿主 RPC 端点（WebUI「定时任务」卡片的数据面）。
 *
 * 数据在插件 dataDir 的 tasks.json，不走 settings 文档。与人格库的
 * 「整表替换」不同，任务用**单任务操作**（upsert/delete/toggle/run）：
 * agent 会在会话里并发建任务，整表替换会让 WebUI 的旧快照覆盖掉它们。
 *
 * 返回 undefined 表示端点不属于本模块（调用方继续尝试其它端点）。
 */
import type { ConnectionRpcResultLike } from '../dsh.ts';
import type { Logger } from '../types.ts';
import { formatChatSelector, parseChatSelector } from '../persona/routes.ts';
import { type TaskSchedule } from './schedule.ts';
import { MAX_TASKS, validateTaskInput, type ScheduledTask, type TaskStore } from './store.ts';

export type TaskRpcResult = ConnectionRpcResultLike;

/** 「定时任务」卡片一行的浏览器面（schedule 拆平；时间戳为 epoch ms）。 */
export interface TaskView {
	id: string;
	/** 会话选择器文本（friend_/group_；perUser 等特殊键原样回显）。 */
	chat: string;
	chatKey: string;
	chatType: 'private' | 'group';
	chatId: string;
	prompt: string;
	note: string;
	kind: 'once' | 'daily' | 'weekly';
	time: string;
	weekdays: number[];
	runAt: string;
	enabled: boolean;
	createdBy: string;
	createdAt: number;
	lastRunAt: number | null;
	/** 下一次计划触发（调度器的活地图；未排队 = null）。 */
	nextRunAt: number | null;
}

export interface TaskRpcDeps {
	store: TaskStore;
	/** 读某任务的下一次计划触发（TaskScheduler.nextRunOf）。 */
	nextRunOf(id: string): number | undefined;
	/** 单会话任务上限（实时读运行配置，WebUI 热改即生效）。 */
	perChatLimit: () => number;
	/** 立即触发一次（不经调度器计时，不影响 lastRunAt 语义）。 */
	runTask(task: ScheduledTask): void;
	logger: Logger;
}

const ok = (value: unknown): TaskRpcResult => ({ ok: true, value });
const fail = (code: string, message: string): TaskRpcResult => ({ ok: false, error: { code, message } });

function asRecord(payload: unknown): Record<string, unknown> {
	return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function toView(task: ScheduledTask, nextRunOf: (id: string) => number | undefined): TaskView {
	return {
		id: task.id,
		chat: formatChatSelector(task.chatKey) ?? task.chatKey,
		chatKey: task.chatKey,
		chatType: task.chatType,
		chatId: task.chatId,
		prompt: task.prompt,
		note: task.note ?? '',
		kind: task.schedule.kind,
		time: task.schedule.kind === 'once' ? '' : task.schedule.time,
		weekdays: task.schedule.kind === 'weekly' ? task.schedule.weekdays : [],
		runAt: task.schedule.kind === 'once' ? task.schedule.runAt : '',
		enabled: task.enabled,
		createdBy: task.createdBy ?? '',
		createdAt: task.createdAt,
		lastRunAt: task.lastRunAt ?? null,
		nextRunAt: nextRunOf(task.id) ?? null,
	};
}

function listViews(deps: TaskRpcDeps): TaskView[] {
	return deps.store.list().map((task) => toView(task, (id) => deps.nextRunOf(id)));
}

/** 校验 upsert 的会话选择器 + 时间表；非法返回错误文案。 */
function parseUpsert(
	payload: Record<string, unknown>,
): { value: { id?: string; chatKey: string; chatType: 'private' | 'group'; chatId: string; prompt: string; note: string; schedule: TaskSchedule } } | { error: string } {
	const id = typeof payload.id === 'string' && payload.id.trim() !== '' ? payload.id.trim() : undefined;
	const chat = typeof payload.chat === 'string' ? payload.chat.trim() : '';
	// 表格输入与「人格与模型」卡片同一套选择器：friend_/group_（也接受 u-/g- 往返编辑）。
	const selector = parseChatSelector(chat);
	if (selector === null) return { error: `无法识别的会话：${chat === '' ? '（空）' : chat}（应为 friend_QQ号 或 group_群号）` };
	const validated = validateTaskInput({
		chatKey: selector.key,
		chatType: selector.scope,
		chatId: selector.chatId,
		prompt: payload.prompt,
		note: payload.note,
		kind: payload.kind,
		time: payload.time,
		weekdays: payload.weekdays,
		runAt: payload.runAt,
	});
	if ('error' in validated) return validated;
	return { value: { id, chatKey: validated.chatKey, chatType: validated.chatType, chatId: validated.chatId, prompt: validated.prompt, note: validated.note ?? '', schedule: validated.schedule } };
}

/**
 * 处理一个端点；不是本模块的端点返回 undefined。
 * 支持的端点：tasks/list | tasks/upsert | tasks/delete | tasks/toggle | tasks/run。
 */
export async function handleTaskRpc(endpoint: string, payload: unknown, deps: TaskRpcDeps): Promise<TaskRpcResult | undefined> {
	try {
		if (endpoint === 'tasks/list') {
			return ok({ tasks: listViews(deps) });
		}
		if (endpoint === 'tasks/upsert') {
			const parsed = parseUpsert(asRecord(payload));
			if ('error' in parsed) return fail('invalid', parsed.error);
			const task = parsed.value;
			if (task.id !== undefined) {
				const existing = deps.store.get(task.id);
				if (existing === undefined) return fail('not-found', `任务 ${task.id} 不存在`);
				const changed = deps.store.update(task.id, {
					chatKey: task.chatKey,
					chatType: task.chatType,
					chatId: task.chatId,
					prompt: task.prompt,
					note: task.note,
					schedule: task.schedule,
				});
				deps.logger.info(`dsh-qq-bot: 定时任务 ${task.id} 已通过 WebUI 更新（${task.schedule.kind}）`);
				return ok({ tasks: listViews(deps), id: changed?.id });
			}
			const added = deps.store.add(
				{
					chatKey: task.chatKey,
					chatType: task.chatType,
					chatId: task.chatId,
					prompt: task.prompt,
					schedule: task.schedule,
					note: task.note === '' ? undefined : task.note,
					createdBy: undefined,
				},
				{ total: MAX_TASKS, perChat: deps.perChatLimit() },
			);
			if ('error' in added) return fail('limit', added.error);
			deps.logger.info(`dsh-qq-bot: 定时任务 ${added.task.id} 已通过 WebUI 创建（${task.schedule.kind}）`);
			return ok({ tasks: listViews(deps), id: added.task.id });
		}
		if (endpoint === 'tasks/delete') {
			const id = typeof asRecord(payload).id === 'string' ? (asRecord(payload).id as string) : '';
			if (!deps.store.remove(id)) return fail('not-found', `任务 ${id} 不存在`);
			deps.logger.info(`dsh-qq-bot: 定时任务 ${id} 已通过 WebUI 删除`);
			return ok({ tasks: listViews(deps) });
		}
		if (endpoint === 'tasks/toggle') {
			const body = asRecord(payload);
			const id = typeof body.id === 'string' ? body.id : '';
			const enabled = body.enabled === true;
			const task = deps.store.setEnabled(id, enabled);
			if (task === undefined) return fail('not-found', `任务 ${id} 不存在`);
			deps.logger.info(`dsh-qq-bot: 定时任务 ${id} 已${enabled ? '启用' : '停用'}（WebUI）`);
			return ok({ tasks: listViews(deps) });
		}
		if (endpoint === 'tasks/run') {
			const id = typeof asRecord(payload).id === 'string' ? (asRecord(payload).id as string) : '';
			const task = deps.store.get(id);
			if (task === undefined) return fail('not-found', `任务 ${id} 不存在`);
			deps.runTask(task);
			deps.logger.info(`dsh-qq-bot: 定时任务 ${id} 已手动触发（WebUI）`);
			return ok({ tasks: listViews(deps) });
		}
		return undefined;
	} catch (error) {
		deps.logger.warn(`dsh-qq-bot: ${endpoint} 处理失败: ${error instanceof Error ? error.message : String(error)}`);
		return fail('internal', error instanceof Error ? error.message : String(error));
	}
}
