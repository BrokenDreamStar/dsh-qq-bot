/** /logs 文本渲染测试。 */
import { describe, expect, it } from 'vitest';
import { formatLogEntry, formatLogDigest } from './format.ts';
import type { MessageLogEntry } from './store.ts';

function entry(partial: Partial<MessageLogEntry>): MessageLogEntry {
	return {
		seq: 1,
		ts: new Date('2026-01-01T12:34:56').getTime(),
		dir: 'in',
		scope: 'onebot',
		event: 'message',
		text: '你好',
		...partial,
	};
}

describe('formatLogEntry', () => {
	it('群消息带发送者与聊天标签', () => {
		const line = formatLogEntry(entry({ chatType: 'group', chatId: '123', senderId: '456', senderName: '张三' }));
		expect(line).toBe('12:34:56 [收] OB message 群123 张三(456)：你好');
	});

	it('出站 dsh 回复', () => {
		const line = formatLogEntry(entry({ dir: 'out', scope: 'dsh', event: 'reply', chatType: 'private', chatId: '42' }));
		expect(line).toBe('12:34:56 [发] dsh reply 私聊42：你好');
	});

	it('管线丢弃行', () => {
		const line = formatLogEntry(entry({ dir: 'sys', scope: 'pipeline', event: 'drop', chatId: '9', text: '访问控制拒绝' }));
		expect(line).toBe('12:34:56 [系] 管线 drop 私聊9：访问控制拒绝');
	});

	it('无会话信息时不带冒号', () => {
		const line = formatLogEntry(entry({ chatType: undefined, chatId: undefined, senderId: undefined, senderName: undefined }));
		expect(line).toBe('12:34:56 [收] OB message 你好');
	});

	it('多行文本折叠为 ⏎', () => {
		const line = formatLogEntry(entry({ text: '第一行\n第二行' }));
		expect(line).toContain('第一行⏎第二行');
	});
});

describe('formatLogDigest', () => {
	it('带统计头并保持旧→新顺序', () => {
		const digest = formatLogDigest([entry({ chatId: '1', text: 'a' }), entry({ seq: 2, chatId: '1', text: 'b' })], 5);
		const lines = digest.split('\n');
		expect(lines[0]).toContain('显示最近 2 条 / 缓冲 5 条');
		expect(lines[1]!.endsWith('a')).toBe(true);
		expect(lines[2]!.endsWith('b')).toBe(true);
		expect(lines[1]!.endsWith('b')).toBe(false);
	});

	it('空缓冲提示', () => {
		expect(formatLogDigest([], 0)).toContain('缓冲为空');
	});
});
