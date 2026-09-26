/**
 * 定时任务库：<dataDir>/tasks.json 持久化（重启后任务继续生效）。
 *
 * 每个任务绑定创建它的那个 QQ 会话（chatKey），到期由 TaskScheduler 触发、
 * 经对应会话桥把 agent 的执行结果主动发回该会话——任务不能指定任意目标，
 * 主动消息只能落在发起会话里，这是刻意的安全边界。
 *
 * 写入来源共用同一份数据：
 *  - agent 工具 task_schedule / task_cancel（会话内自然语言创建/取消）；
 *  - WebUI「定时任务」卡片（走宿主 RPC，单任务增删改）；
 *  - 会话内 /tasks 命令（查看与简单管理）。
 *
 * onChange 在任何变更后触发（index.ts 接到 TaskScheduler.refresh 重算触发点）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../types.ts';
import { normalizeTaskSchedule, type TaskSchedule } from './schedule.ts';

export const MAX_TASKS = 200;
export const MAX_TASK_PROMPT_CHARS = 2000;
export const MAX_TASK_NOTE_CHARS = 200;

export interface ScheduledTask {
	id: string;
	/** 创建会话的派生键（`u-<QQ号>` / `g-<群号>` / `g-<群号>-u-<QQ号>`）。 */
	chatKey: string;
	chatType: 'private' | 'group';
	/** 群号或对方 QQ 号。 */
	chatId: string;
	/** 到期时交给 agent 的指令（写给未来的自己）。 */
	prompt: string;
	/** 任务备注（任务列表展示用）。 */
	note?: string;
	schedule: TaskSchedule;
	enabled: boolean;
	/** 创建者 QQ 号（工具链路带入；到期轮次的工具权限按它判定）。 */
	createdBy?: string;
	createdAt: number;
	/** 上次实际触发时间（补账锚点）。 */
	lastRunAt?: number;
}

export interface TaskInput {
	chatKey: string;
	chatType: 'private' | 'group';
	chatId: string;
	prompt: string;
	schedule: TaskSchedule;
	note?: string;
	createdBy?: string;
}

export interface TaskLimits {
	/** 全库上限（超了拒绝新建）。 */
	total: number;
	/** 单会话上限（超了拒绝新建；防止单个会话刷任务占满队列）。 */
	perChat: number;
}

/** 规范化一个任务输入（工具 / RPC / 命令共用）；非法返回错误文案。 */
export function validateTaskInput(input: {
	chatKey?: unknown;
	chatType?: unknown;
	chatId?: unknown;
	prompt?: unknown;
	note?: unknown;
	kind?: unknown;
	time?: unknown;
	weekdays?: unknown;
	runAt?: unknown;
}): { chatKey: string; chatType: 'private' | 'group'; chatId: string; prompt: string; note?: string; schedule: TaskSchedule } | { error: string } {
	const chatKey = typeof input.chatKey === 'string' ? input.chatKey.trim() : '';
	if (chatKey === '' || chatKey.length > 64) return { error: '会话键（chatKey）缺失或非法' };
	const chatType = input.chatType === 'group' ? 'group' : input.chatType === 'private' ? 'private' : undefined;
	if (chatType === undefined) return { error: "chatType 必须是 'private' | 'group'" };
	const chatId = typeof input.chatId === 'string' && /^\d{5,12}$/.test(input.chatId.trim()) ? input.chatId.trim() : '';
	if (chatId === '') return { error: '会话号码（QQ号/群号）缺失或非法' };
	const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
	if (prompt === '') return { error: '任务内容（prompt）不能为空' };
	if (prompt.length > MAX_TASK_PROMPT_CHARS) return { error: `任务内容不能超过 ${MAX_TASK_PROMPT_CHARS} 字` };
	let note: string | undefined;
	if (input.note !== undefined && input.note !== null) {
		const trimmed = typeof input.note === 'string' ? input.note.trim() : '';
		if (trimmed !== '') {
			if (trimmed.length > MAX_TASK_NOTE_CHARS) return { error: `备注不能超过 ${MAX_TASK_NOTE_CHARS} 字` };
			note = trimmed;
		}
	}
	const schedule = normalizeTaskSchedule(input);
	if ('error' in schedule) return schedule;
	return { chatKey, chatType, chatId, prompt, note, schedule: schedule.schedule };
}

export class TaskStore {
	private tasks: ScheduledTask[] = [];
	private readonly filePath: string;

	/** 任何变更后回调（index.ts 接 TaskScheduler.refresh；未接线时调度器自行 advance）。 */
	onChange?: () => void;

	constructor(
		dataDir: string,
		private readonly logger: Logger,
	) {
		this.filePath = join(dataDir, 'tasks.json');
	}

	/** 加载（幂等）；文件缺失或损坏视为空库，不阻塞启动。 */
	init(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
		} catch {
			// 写入时仍会暴露。
		}
		try {
			if (!existsSync(this.filePath)) return;
			const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
			if (!Array.isArray(parsed)) return;
			const tasks: ScheduledTask[] = [];
			for (const raw of parsed) {
				const task = reviveTask(raw);
				if (task !== undefined) tasks.push(task);
			}
			this.tasks = tasks;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取 tasks.json 失败（视为无定时任务）: ${error instanceof Error ? error.message : String(error)}`);
			this.tasks = [];
		}
	}

	private save(): void {
		try {
			writeFileSync(this.filePath, `${JSON.stringify(this.tasks, null, 2)}\n`, 'utf8');
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写 tasks.json 失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private changed(): void {
		this.save();
		this.onChange?.();
	}

	list(): readonly ScheduledTask[] {
		return this.tasks;
	}

	listByChat(chatKey: string): ScheduledTask[] {
		return this.tasks.filter((task) => task.chatKey === chatKey);
	}

	get(id: string): ScheduledTask | undefined {
		return this.tasks.find((task) => task.id === id);
	}

	countByChat(chatKey: string): number {
		return this.listByChat(chatKey).length;
	}

	/** 新建任务（输入先过 validateTaskInput 的调用方已保证形状）。 */
	add(input: TaskInput, limits: TaskLimits): { task: ScheduledTask } | { error: string } {
		if (this.tasks.length >= limits.total) return { error: `定时任务总数已达上限（${limits.total}），请先清理不用的任务` };
		if (this.countByChat(input.chatKey) >= limits.perChat) return { error: `本会话定时任务已达上限（${limits.perChat}），请先取消一些` };
		const task: ScheduledTask = {
			id: newTaskId(),
			chatKey: input.chatKey,
			chatType: input.chatType,
			chatId: input.chatId,
			prompt: input.prompt,
			schedule: input.schedule,
			enabled: true,
			createdAt: Date.now(),
		};
		if (input.note !== undefined) task.note = input.note;
		if (input.createdBy !== undefined && input.createdBy !== '') task.createdBy = input.createdBy;
		this.tasks.push(task);
		this.changed();
		return { task };
	}

	/** 更新任务内容（WebUI 编辑；chatKey 变更 = 换绑会话）。 */
	update(
		id: string,
		patch: Partial<Pick<ScheduledTask, 'chatKey' | 'chatType' | 'chatId' | 'prompt' | 'note' | 'schedule'>>,
	): ScheduledTask | undefined {
		const task = this.get(id);
		if (task === undefined) return undefined;
		if (patch.chatKey !== undefined) task.chatKey = patch.chatKey;
		if (patch.chatType !== undefined) task.chatType = patch.chatType;
		if (patch.chatId !== undefined) task.chatId = patch.chatId;
		if (patch.prompt !== undefined) task.prompt = patch.prompt;
		if (patch.note !== undefined) {
			if (patch.note === '') delete task.note;
			else task.note = patch.note;
		}
		if (patch.schedule !== undefined) task.schedule = patch.schedule;
		this.changed();
		return task;
	}

	remove(id: string): boolean {
		const before = this.tasks.length;
		this.tasks = this.tasks.filter((task) => task.id !== id);
		if (this.tasks.length === before) return false;
		this.changed();
		return true;
	}

	setEnabled(id: string, enabled: boolean): ScheduledTask | undefined {
		const task = this.get(id);
		if (task === undefined || task.enabled === enabled) return task;
		task.enabled = enabled;
		this.changed();
		return task;
	}

	/** 记录一次实际触发（调度器用；作为重启补账的锚点）。 */
	markRun(id: string, atMs: number): void {
		const task = this.get(id);
		if (task === undefined) return;
		task.lastRunAt = atMs;
		this.changed();
	}
}

function newTaskId(): string {
	return `t-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** 从磁盘恢复单条任务：字段逐个校验，坏条目跳过而不是让整库作废。 */
function reviveTask(raw: unknown): ScheduledTask | undefined {
	if (raw === null || typeof raw !== 'object') return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.id !== 'string' || record.id === '') return undefined;
	const schedule = normalizeTaskSchedule(record.schedule);
	if ('error' in schedule) return undefined;
	const chatKey = typeof record.chatKey === 'string' ? record.chatKey : '';
	const chatType = record.chatType === 'group' ? 'group' : 'private';
	const chatId = typeof record.chatId === 'string' ? record.chatId : '';
	const prompt = typeof record.prompt === 'string' ? record.prompt : '';
	if (chatKey === '' || prompt === '') return undefined;
	const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now();
	const task: ScheduledTask = {
		id: record.id,
		chatKey,
		chatType,
		chatId,
		prompt,
		schedule: schedule.schedule,
		enabled: record.enabled !== false,
		createdAt,
	};
	if (typeof record.note === 'string' && record.note !== '') task.note = record.note;
	if (typeof record.createdBy === 'string' && record.createdBy !== '') task.createdBy = record.createdBy;
	if (typeof record.lastRunAt === 'number' && Number.isFinite(record.lastRunAt)) task.lastRunAt = record.lastRunAt;
	return task;
}
