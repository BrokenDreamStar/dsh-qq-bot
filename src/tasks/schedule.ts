/**
 * 定时任务的时间表（纯逻辑，可测；宿主半与客户端 bundle 共用）。
 *
 * 三种周期覆盖 AstrBot「未来任务」的常见话术：
 *  - once   一次性：'YYYY-MM-DD HH:mm'（宿主机本地时间）
 *  - daily  每天：'HH:mm'
 *  - weekly 每周：'HH:mm' + 星期集合（0=周日 … 6=周六）
 *
 * 触发计算基于**宿主机本地时间**（时间感知 section 告诉模型的同一时钟），
 * 跨天用 Date 的本地字段加减，夏令时边界按本地钟面时间对齐（可能 23/25h）。
 */

export type TaskKind = 'once' | 'daily' | 'weekly';

export type TaskSchedule =
	| { kind: 'once'; runAt: string }
	| { kind: 'daily'; time: string }
	| { kind: 'weekly'; time: string; weekdays: number[] };

/** 星期显示名（describeSchedule 与客户端共用；0=周日）。 */
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

const pad2 = (value: number): string => String(value).padStart(2, '0');

const TIME_RE = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/;
const RUN_AT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;

/** 把 '9' / '9:5' / '09:05:00' 规范为 'HH:mm'；非法返回 null。 */
export function normalizeTimeInput(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const match = TIME_RE.exec(text.trim());
	if (match === null) return null;
	const hour = Number(match[1]);
	const minute = match[2] !== undefined ? Number(match[2]) : 0;
	const second = match[3] !== undefined ? Number(match[3]) : 0;
	if (hour > 23 || minute > 59 || second > 59) return null;
	return `${pad2(hour)}:${pad2(minute)}`;
}

/** 该年月日时分是否是真实存在的钟面时间（拦 2 月 30 日这类输入）。 */
function isRealLocalTime(year: number, month1: number, day: number, hour: number, minute: number): boolean {
	const date = new Date(year, month1 - 1, day, hour, minute);
	return date.getFullYear() === year && date.getMonth() === month1 - 1 && date.getDate() === day;
}

/**
 * 把一次性触发时间规范为 'YYYY-MM-DD HH:mm'（宿主机本地时间）。
 * 接受 'YYYY-MM-DD HH:mm[:ss]' 与 'YYYY-MM-DDTHH:mm[:ss]'（datetime-local 的
 * 原生格式）。故意不接 Date.parse 兜底——'YYYY-MM-DD' 会被当成 UTC，时区
 * 语义含混；本地开发里也用不到毫秒级精度。
 */
export function normalizeRunAtInput(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const match = RUN_AT_RE.exec(text.trim());
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = match[6] !== undefined ? Number(match[6]) : 0;
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
	if (!isRealLocalTime(year, month, day, hour, minute)) return null;
	return `${match[1]}-${match[2]}-${match[3]} ${pad2(hour)}:${pad2(minute)}`;
}

/** 'YYYY-MM-DD HH:mm' → epoch ms（本地时区）；非法返回 null。 */
export function runAtToMs(runAt: string): number | null {
	const normalized = normalizeRunAtInput(runAt);
	if (normalized === null) return null;
	const match = RUN_AT_RE.exec(normalized);
	if (match === null) return null;
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime();
}

/** 星期集合规范为排序去重的 0..6 数组；空/越界/不可解析返回 null。 */
export function normalizeWeekdaysInput(values: unknown): number[] | null {
	if (!Array.isArray(values) || values.length === 0) return null;
	const set = new Set<number>();
	for (const value of values) {
		const parsed =
			typeof value === 'number' ? Math.trunc(value) : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) return null;
		set.add(parsed);
	}
	return [...set].sort((a, b) => a - b);
}

/** 按工具/WebUI 输入校验并规范化一张时间表；非法返回错误文案。 */
export function normalizeTaskSchedule(input: unknown): { schedule: TaskSchedule } | { error: string } {
	const record = (input !== null && typeof input === 'object' ? input : {}) as { kind?: unknown; time?: unknown; weekdays?: unknown; runAt?: unknown };
	switch (record.kind) {
		case 'once': {
			const runAt = normalizeRunAtInput(record.runAt);
			if (runAt === null) return { error: '一次性任务需要有效的触发时间（YYYY-MM-DD HH:mm，宿主机本地时间）' };
			return { schedule: { kind: 'once', runAt } };
		}
		case 'daily': {
			const time = normalizeTimeInput(record.time);
			if (time === null) return { error: '每天任务需要有效的 HH:mm 时间' };
			return { schedule: { kind: 'daily', time } };
		}
		case 'weekly': {
			const time = normalizeTimeInput(record.time);
			if (time === null) return { error: '每周任务需要有效的 HH:mm 时间' };
			const weekdays = normalizeWeekdaysInput(record.weekdays);
			if (weekdays === null) return { error: '每周任务需要 0-6 的星期集合（0=周日）' };
			return { schedule: { kind: 'weekly', time, weekdays } };
		}
		default:
			return { error: "kind 必须是 'once' | 'daily' | 'weekly'" };
	}
}

/**
 * 某时间表在 afterMs（含创建锚点语义）之后的下一次触发；没有下次返回 null
 * （once 已过期）。调度器与 /tasks、工具回显共用这一个定义。
 */
export function nextRunAt(schedule: TaskSchedule, afterMs: number): number | null {
	if (schedule.kind === 'once') {
		const at = runAtToMs(schedule.runAt);
		return at !== null && at > afterMs ? at : null;
	}
	const time = normalizeTimeInput(schedule.time);
	if (time === null) return null;
	const [hour, minute] = time.split(':').map((part) => Number(part));
	const base = new Date(afterMs);
	base.setHours(hour!, minute!, 0, 0);
	if (schedule.kind === 'daily') {
		if (base.getTime() <= afterMs) base.setDate(base.getDate() + 1);
		return base.getTime();
	}
	let best: number | null = null;
	for (const weekday of schedule.weekdays) {
		const candidate = new Date(base);
		candidate.setDate(candidate.getDate() + ((weekday - candidate.getDay() + 7) % 7));
		if (candidate.getTime() <= afterMs) candidate.setDate(candidate.getDate() + 7);
		if (best === null || candidate.getTime() < best) best = candidate.getTime();
	}
	return best;
}

/** 任务实体的下一次触发（调度器 rebuild 与 /tasks 展示共用的锚点定义）。 */
export function nextRunForTask(task: { schedule: TaskSchedule; lastRunAt?: number; createdAt: number }): number | null {
	return nextRunAt(task.schedule, task.lastRunAt ?? task.createdAt);
}

/** 时间表的人类可读描述（/tasks、工具回显、任务触发提示共用）。 */
export function describeSchedule(schedule: TaskSchedule): string {
	if (schedule.kind === 'once') return `${schedule.runAt}（一次性）`;
	if (schedule.kind === 'daily') return `每天 ${schedule.time}`;
	return `每周${schedule.weekdays.map((weekday) => WEEKDAY_LABELS[weekday] ?? String(weekday)).join('、')} ${schedule.time}`;
}
