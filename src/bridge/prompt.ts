/**
 * 引用回复语义还原：把"回复 XXX 的消息"还原成模型可读的引用块，
 * 让"他说的不对"这类指代落地。
 */
import type { OneBotApi, MsgResult } from '../onebot/api.ts';
import { parseCQ, segmentsToText, type OBSegment } from '../onebot/segments.ts';
import type { Logger } from '../types.ts';

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/**
 * 宿主机当前时间的人类可读形态（时间感知 section 用）：
 * `2026-09-13 周六 14:30:05（UTC+08:00）`。手工拼接而非 Intl，保证
 * 各宿主 locale 下格式稳定，也便于模型按同一格式推理"明天9点"这类相对时间。
 */
export function formatHostTime(now: Date): string {
	const offsetMinutes = -now.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? '+' : '-';
	const absOffset = Math.abs(offsetMinutes);
	const offset = `UTC${sign}${String(Math.floor(absOffset / 60)).padStart(2, '0')}:${String(absOffset % 60).padStart(2, '0')}`;
	const pad = (value: number): string => String(value).padStart(2, '0');
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
		`${WEEKDAY_NAMES[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}（${offset}）`
	);
}

export interface QuotedContext {
	/** 被引用消息发送者号码：**只用于内部逻辑，不要渲染进模型可见文本**。 */
	senderId: string;
	senderName: string;
	text: string;
}

/**
 * 渲染进 agent 消息的引用块（单行包裹，模型按块识别）。
 *
 * **只写昵称、不写号码**：号码一旦出现在模型可见文本里，模型回复时就会照抄
 * （用户明确要求机器人不要在群里输出别人的 QQ 号），见 roster.ts 的同一约定。
 */
export function buildQuotedBlock(quoted: QuotedContext): string {
	const text = quoted.text.replace(/\s+$/, '');
	return `[回复 ${quoted.senderName} 的消息：${text}]`;
}

/** 从 get_msg 结果里取可读文本（段数组 / CQ 码 / raw_message 兜底）。 */
function quotedMsgText(msg: MsgResult): string {
	const raw = msg.message;
	if (Array.isArray(raw)) return segmentsToText(raw as OBSegment[]);
	if (typeof raw === 'string' && raw !== '') return segmentsToText(parseCQ(raw));
	if (typeof msg.raw_message === 'string' && msg.raw_message !== '') return segmentsToText(parseCQ(msg.raw_message));
	return typeof msg.content === 'string' ? msg.content : '';
}

/**
 * 反查被引用消息；查不到或原文为空时返回 undefined（不阻断主消息）。
 * 文本按 maxChars 截断，防止长引用刷爆上下文。
 */
export async function resolveQuoted(options: {
	api: OneBotApi;
	replyMessageId?: string;
	maxChars: number;
	logger: Logger;
}): Promise<QuotedContext | undefined> {
	const id = options.replyMessageId;
	if (id === undefined || id === '') return undefined;
	const msg = await options.api.getMsg(id);
	if (msg === undefined) {
		options.logger.warn(`dsh-qq-bot: 引用消息 ${id} 反查失败`);
		return undefined;
	}
	const senderId = String(msg.sender?.user_id ?? '');
	const senderName = String(msg.sender?.card ?? '') || String(msg.sender?.nickname ?? '') || senderId || '未知成员';
	const text = quotedMsgText(msg).trim().slice(0, Math.max(options.maxChars, 0));
	if (text === '') return undefined;
	return { senderId, senderName, text };
}
