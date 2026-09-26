/**
 * 世代交接块：纯逻辑（构造与渲染），不碰数据库、不调 LLM。
 *
 * 背景（docs/memory-design.md §7）：dsh-qq-bot 的会话世代会因为写句柄冲突
 * （`rotateOwnedSession`）、`/reset`、进程重启而更换。新世代的 agent 对上一段
 * 对话一无所知，容易开口就问「我们刚才说到哪」。交接块就是把这条缝补上：
 * **只补卡片里没有的两样东西** —— 「上次聊到哪儿」和「最后几条原话」。
 *
 * 刻意不重复 L0 卡片：新世代的卡片是**冻结加载的最新版**（service 渲染时读的就是
 * 磁盘最新），所以交接块里再放一遍纯属浪费 prefill。
 */

import { sanitizeMemoryText } from './guard.ts';
import { formatEntryTime } from '../onebot/history.ts';
import {
	HANDOFF_HEADER,
	MAX_HANDOFF_TAIL_LINE_CHARS,
	MEMORY_SAFETY_NOTE,
	type HandoffInput,
	type MemoryEvent,
} from './types.ts';

/** 交接块默认的字符预算（超出时从最旧的 tail 行开始丢）。 */
export const HANDOFF_MAX_CHARS = 1200;

/**
 * 渲染交接块。
 *
 * @param input - 上世代的尾巴与摘要。
 * @param options - `now` 可注入（测试）；`maxChars` 覆盖默认预算。
 * @returns 交接块文本；**没有可交接内容时返回空串**（调用方据此跳过注入）。
 */
export function renderHandoff(
	input: HandoffInput,
	options: { now?: number; maxChars?: number } = {},
): string {
	const now = options.now ?? Date.now();
	const maxChars = Math.max(200, options.maxChars ?? HANDOFF_MAX_CHARS);
	const tail = packTail(input.tail, now, maxChars);
	const hasSummary = input.summary !== undefined && input.summary.trim() !== '';
	if (tail.length === 0 && !hasSummary && input.lastActivityAt <= 0) return '';

	const when = input.lastActivityAt > 0 ? formatTimestamp(input.lastActivityAt, now) : '（时间未知）';
	const lines: string[] = [`${HANDOFF_HEADER}`, `本会话上一次对话在${when}结束。`];
	if (hasSummary) lines.push(`上次进度：${sanitizeMemoryText(input.summary ?? '')}`);
	if (tail.length > 0) {
		lines.push(`最后 ${tail.length} 条消息（时间正序）：`);
		lines.push(...tail.map((event) => renderTailLine(event, now)));
	}
	lines.push('（这是你自己上一段对话的结尾，别问用户「我们刚才说到哪」；需要更早的内容用 qq_recall_memory 查。）');
	lines.push(MEMORY_SAFETY_NOTE);
	return lines.join('\n');
}

/** 从最新往旧取，直到超出预算（保留的仍是时间正序）。 */
function packTail(events: readonly MemoryEvent[], now: number, maxChars: number): MemoryEvent[] {
	const kept: MemoryEvent[] = [];
	let used = 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event === undefined) continue;
		const cost = renderTailLine(event, now).length + 1;
		if (kept.length > 0 && used + cost > maxChars) break;
		kept.unshift(event);
		used += cost;
	}
	return kept;
}

/** 交接尾巴的一行：只给昵称，**不带 QQ 号**（号码会被模型照抄进回复）。 */
function renderTailLine(event: MemoryEvent, now: number): string {
	const who = event.senderName !== '' ? event.senderName : event.senderId;
	const text = sanitizeMemoryText(event.text);
	const clipped = text.length > MAX_HANDOFF_TAIL_LINE_CHARS ? `${text.slice(0, MAX_HANDOFF_TAIL_LINE_CHARS - 1)}…` : text;
	return `[${formatEntryTime(event.ts, now)}] ${who}${event.self ? '【你】' : ''}：${clipped}`;
}

function formatTimestamp(timeMs: number, now: number): string {
	const date = new Date(timeMs);
	const pad = (value: number): string => String(value).padStart(2, '0');
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	// 同一天只给时刻，跨天给完整日期（群里绝大多数交接是同一天内的）。
	return new Date(now).toDateString() === date.toDateString() ? `今天 ${clock}` : `${day} ${clock}`;
}

/**
 * 交接块是否值得注入。
 *
 * 空世代（tail 为空、没有摘要、没有时间）不注入 —— 首次使用的会话不该看到
 * 一条「上一次对话在…结束」的空壳。
 */
export function shouldHandoff(input: HandoffInput): boolean {
	return input.lastActivityAt > 0 && (input.tail.length > 0 || (input.summary ?? '').trim() !== '');
}
