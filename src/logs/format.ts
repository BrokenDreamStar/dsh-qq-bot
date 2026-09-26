/** /logs 命令的纯文本渲染（纯函数，可测）。 */
import type { MessageLogEntry } from './store.ts';

const DIR_LABEL: Record<MessageLogEntry['dir'], string> = { in: '收', out: '发', sys: '系' };
const SCOPE_LABEL: Record<MessageLogEntry['scope'], string> = { onebot: 'OB', dsh: 'dsh', pipeline: '管线', search: '搜索' };

function clockTime(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function chatLabel(entry: MessageLogEntry): string {
	if (entry.chatId === undefined) return '';
	return entry.chatType === 'group' ? `群${entry.chatId}` : `私聊${entry.chatId}`;
}

function senderLabel(entry: MessageEntryLike): string {
	if (entry.senderName !== undefined && entry.senderName !== '' && entry.senderId !== undefined && entry.senderName !== entry.senderId) {
		return `${entry.senderName}(${entry.senderId})`;
	}
	if (entry.senderName !== undefined && entry.senderName !== '') return entry.senderName;
	if (entry.senderId !== undefined) return entry.senderId;
	return '';
}

type MessageEntryLike = Pick<MessageLogEntry, 'senderId' | 'senderName'>;

/** 单行渲染：`12:34:56 [收] OB 群123 张三(456)：你好`。 */
export function formatLogEntry(entry: MessageLogEntry): string {
	const parts = [
		clockTime(entry.ts),
		`[${DIR_LABEL[entry.dir]}]`,
		SCOPE_LABEL[entry.scope],
		entry.event,
	];
	const chat = chatLabel(entry);
	if (chat !== '') parts.push(chat);
	const sender = senderLabel(entry);
	if (sender !== '') parts.push(sender);
	const head = parts.join(' ');
	const text = entry.text.replaceAll('\n', '⏎');
	return sender !== '' || chat !== '' ? `${head}：${text}` : `${head} ${text}`;
}

/** 渲染最近条目（旧→新），附条数统计头。 */
export function formatLogDigest(entries: MessageLogEntry[], total: number): string {
	const lines = entries.map(formatLogEntry);
	const head = `消息日志（显示最近 ${entries.length} 条 / 缓冲 ${total} 条，旧→新）：`;
	return lines.length === 0 ? '缓冲为空，暂无消息日志。' : [head, ...lines].join('\n');
}
