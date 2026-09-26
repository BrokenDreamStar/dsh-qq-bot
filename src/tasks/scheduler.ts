/**
 * 定时任务触发器：把 tasks.json 里到期的任务经会话桥变成主动消息。
 *
 * 设计要点：
 *  - 每 15s 扫一遍内存触发表（任务量 ≤ 上限，全表扫描可忽略）；
 *  - 触发表在 store 变化（onChange → refresh）与每次触发后全量重算，
 *    不维护增量结构——正确性优先，量级不值得；
 *  - 断电/停机补账：锚点 = lastRunAt ?? createdAt。重启后若某任务的
 *    计划点已过且在宽限期内（默认 30 分钟），立即补发一次；超过宽限期
 *    视为过期提醒，跳过（一次性任务顺手停用），避免深夜补发"早上叫你起床"；
 *  - fire 是长操作（一轮 agent 对话）：先把 lastRunAt 落盘再触发，
 *    期间 refresh/tick 重入也不会重复触发。
 */
import type { Logger } from '../types.ts';
import { nextRunAt, nextRunForTask, describeSchedule } from './schedule.ts';
import type { ScheduledTask, TaskStore } from './store.ts';

/** 扫描周期（ms）。 */
export const CHECK_INTERVAL_MS = 15_000;
/** 错过计划点多久以内仍补发（ms）；超过则跳过。 */
export const DEFAULT_CATCHUP_MS = 30 * 60_000;

export interface TaskSchedulerDeps {
	store: TaskStore;
	logger: Logger;
	/** 真正把任务变成消息的回调（index.ts 接会话桥管线）。 */
	fire: (task: ScheduledTask) => Promise<void>;
	/** 补账宽限期（测试注入用）。 */
	catchupMs?: number;
}

export class TaskScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	/** 任务 id → 下一次计划触发时间（epoch ms）。 */
	private readonly nextRuns = new Map<string, number>();

	constructor(private readonly deps: TaskSchedulerDeps) {}

	start(): void {
		if (this.timer !== null) return;
		this.refresh();
		this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
		this.timer.unref?.();
		this.deps.logger.info(`dsh-qq-bot: 定时任务触发器已启动（${this.nextRuns.size} 个待触发）`);
	}

	/** 触发器是否在跑（WebUI 热启停判断用）。 */
	get running(): boolean {
		return this.timer !== null;
	}

	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** store 变化后重算全部触发点（含启动时首次）。 */
	refresh(): void {
		this.nextRuns.clear();
		for (const task of this.deps.store.list()) {
			if (!task.enabled) continue;
			const next = nextRunForTask(task);
			if (next !== null) this.nextRuns.set(task.id, next);
		}
	}

	/** 某任务的下一次计划触发（WebUI / RPC 展示用）；未排队返回 undefined。 */
	nextRunOf(id: string): number | undefined {
		return this.nextRuns.get(id);
	}

	private tick(): void {
		const now = Date.now();
		for (const [id, scheduledAt] of [...this.nextRuns]) {
			if (scheduledAt > now) continue;
			this.nextRuns.delete(id);
			const task = this.deps.store.get(id);
			if (task === undefined || !task.enabled) continue;
			void this.fireDue(task, scheduledAt);
		}
	}

	private async fireDue(task: ScheduledTask, scheduledAt: number): Promise<void> {
		const label = task.note ?? task.prompt.slice(0, 30);
		const now = Date.now();
		if (now - scheduledAt > (this.deps.catchupMs ?? DEFAULT_CATCHUP_MS)) {
			this.deps.logger.warn(
				`dsh-qq-bot: 定时任务 ${task.id}「${label}」错过触发点（${describeSchedule(task.schedule)}）超过宽限期，跳过本次`,
			);
		} else {
			// 先落 lastRunAt 再触发：fire 可能耗时数分钟，期间任何 refresh
			// 都按"这次已发生"重算，不会重复触发。
			this.deps.store.markRun(task.id, now);
			try {
				await this.deps.fire(task);
			} catch (error) {
				this.deps.logger.error(`dsh-qq-bot: 定时任务 ${task.id}「${label}」触发失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (task.schedule.kind === 'once') {
			// 一次性任务无论补发还是过期，完成即停用（保留在列表里供查看/删除）。
			this.deps.store.setEnabled(task.id, false);
			return;
		}
		const next = nextRunAt(task.schedule, Date.now());
		if (next !== null && this.deps.store.get(task.id)?.enabled === true) this.nextRuns.set(task.id, next);
	}
}
