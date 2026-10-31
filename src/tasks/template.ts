/**
 * 定时任务的投递方式与「直接推送」模板（纯逻辑，零 node 依赖）。
 *
 * delivery 决定任务到期时怎么处理：
 *  - `agent`（默认）：把 prompt 交给模型执行一轮，回复发回会话（能查资料、调工具）；
 *  - `direct`：不创建、不唤醒任何 agent，把 prompt 里的占位符渲染成文本后
 *    直接发到会话。固定提醒、每日播报这类任务用 direct，不消耗任何 token。
 *
 * 模板占位符在**触发时**按宿主机本地时间渲染：
 *  - `{date}`                   → 2026-10-31
 *  - `{time}`                   → 12:00
 *  - `{weekday}`                → 星期六
 *  - `{daysSince:YYYY-MM-DD}`   → 从起始日到今天的天数（**起始日当天算第 1 天**）
 *
 * 该模块会被 client bundle 直接 import（表单校验用），所以不要引入 node 依赖。
 */

export type TaskDelivery = 'agent' | 'direct';

/** 模板可用占位符说明（工具描述与错误文案共用）。 */
export const TASK_TEMPLATE_HELP =
	'{date}（日期）、{time}（时间）、{weekday}（星期）、{daysSince:YYYY-MM-DD}（从起始日到今天的天数，起始日算第 1 天）';

const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const;
const TOKEN_PATTERN = /\{([a-zA-Z][a-zA-Z0-9]*)(?::([^{}]*))?\}/g;

/** 缺省 / 非法值一律按 agent（兼容旧任务与旧客户端）。 */
export function normalizeTaskDelivery(value: unknown): TaskDelivery {
	return value === 'direct' ? 'direct' : 'agent';
}

interface DateKey {
	year: number;
	month: number;
	day: number;
}

/** 解析严格的 `YYYY-MM-DD`（也校验真实存在的日期）。 */
function parseDateKey(value: string): DateKey | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return { year, month, day };
}

/** 校验直接推送模板；返回错误文案，合法返回 null。 */
export function taskTemplateError(template: string): string | null {
	const invalid: string[] = [];
	for (const match of template.matchAll(TOKEN_PATTERN)) {
		const name = match[1] ?? '';
		const arg = match[2];
		const valid =
			name === 'date' || name === 'time' || name === 'weekday'
				? arg === undefined
				: name === 'daysSince' && arg !== undefined && parseDateKey(arg) !== null;
		if (!valid && !invalid.includes(match[0])) invalid.push(match[0]);
	}
	if (invalid.length === 0) return null;
	return `直接推送模板里有不支持的占位符：${invalid.join(' ')}（可用：${TASK_TEMPLATE_HELP}）`;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** 渲染直接推送模板；未知占位符原样保留（历史数据被手改坏时不至于发不出去）。 */
export function renderTaskTemplate(template: string, at: Date): string {
	const year = at.getFullYear();
	const month = at.getMonth() + 1;
	const day = at.getDate();
	// 按本地日历日做减法（转成 UTC 日历日避免夏令时导致的 23/25 小时误差）。
	const todayUtc = Date.UTC(year, month - 1, day);
	return template.replace(TOKEN_PATTERN, (whole, rawName: string, rawArg: string | undefined) => {
		if (rawName === 'date') return `${year}-${pad(month)}-${pad(day)}`;
		if (rawName === 'time') return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
		if (rawName === 'weekday') return WEEKDAY_LABELS[at.getDay()] ?? '';
		if (rawName === 'daysSince' && rawArg !== undefined) {
			const start = parseDateKey(rawArg);
			if (start === null) return whole;
			const startUtc = Date.UTC(start.year, start.month - 1, start.day);
			return String(Math.round((todayUtc - startUtc) / 86_400_000) + 1);
		}
		return whole;
	});
}
