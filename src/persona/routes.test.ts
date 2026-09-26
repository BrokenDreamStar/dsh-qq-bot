import { describe, expect, it } from 'vitest';
import { formatChatSelector, isChatSelectorKey, parseChatSelector } from './routes.ts';

describe('parseChatSelector', () => {
	it('私聊前缀归一为 u-<QQ号>', () => {
		for (const input of ['friend_10001', 'friend:10001', 'friend 10001', 'friend-10001', 'user_10001', '私聊10001', '好友_10001', 'u-10001']) {
			expect(parseChatSelector(input), input).toEqual({ scope: 'private', chatId: '10001', key: 'u-10001' });
		}
	});

	it('群聊前缀归一为 g-<群号>（含 gorup 手误）', () => {
		for (const input of ['group_123456', 'gorup_123456', 'group:123456', '群123456', '群聊 123456', 'g-123456']) {
			expect(parseChatSelector(input), input).toEqual({ scope: 'group', chatId: '123456', key: 'g-123456' });
		}
	});

	it('大小写宽容、首尾空白忽略', () => {
		expect(parseChatSelector('  FRIEND_42  ')).toEqual({ scope: 'private', chatId: '42', key: 'u-42' });
	});

	it('无法识别的输入返回 null', () => {
		for (const input of ['', '   ', '123456', 'friend_', 'friend_abc', 'wechat_1', 'group:']) {
			expect(parseChatSelector(input), input).toBeNull();
		}
	});
});

describe('formatChatSelector / isChatSelectorKey', () => {
	it('内部键还原为表格写法', () => {
		expect(formatChatSelector('u-10001')).toBe('friend_10001');
		expect(formatChatSelector('g-123456')).toBe('group_123456');
	});

	it('perUser 群会话键与非号码键不可在表格管理', () => {
		expect(formatChatSelector('g-123456-u-10001')).toBeNull();
		expect(isChatSelectorKey('g-123456-u-10001')).toBe(false);
		expect(isChatSelectorKey('g-123456')).toBe(true);
	});

	it('解析与格式化可往返', () => {
		for (const key of ['u-1', 'g-2']) {
			const formatted = formatChatSelector(key);
			expect(formatted).not.toBeNull();
			expect(parseChatSelector(formatted!)?.key).toBe(key);
		}
	});
});
