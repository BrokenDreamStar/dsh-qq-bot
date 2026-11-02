import { describe, expect, it } from 'vitest';
import { chatFieldMode, chatOptionText, parseChatOptions } from './chatPicker.ts';

describe('parseChatOptions', () => {
	it('解析 chats：丢弃空选择器，缺名字时不带 name 字段', () => {
		expect(
			parseChatOptions({
				chats: [
					{ chat: 'group_648399497', kind: 'group', id: '648399497', name: '摸鱼群' },
					{ chat: 'friend_10001', kind: 'private', id: '10001', name: '' },
					{ chat: '', kind: 'group', id: '1' },
					null,
				],
			}),
		).toEqual([
			{ chat: 'group_648399497', kind: 'group', id: '648399497', name: '摸鱼群' },
			{ chat: 'friend_10001', kind: 'private', id: '10001' },
		]);
	});

	it('老宿主 / 坏应答 → 空清单（客户端退回文本框）', () => {
		expect(parseChatOptions(undefined)).toEqual([]);
		expect(parseChatOptions({})).toEqual([]);
		expect(parseChatOptions({ chats: 'nope' })).toEqual([]);
	});
});

describe('chatOptionText', () => {
	it('有名字时「名字 (号码)」，否则原始选择器', () => {
		expect(chatOptionText({ chat: 'group_1', kind: 'group', id: '1', name: '摸鱼群' })).toBe('摸鱼群 (1)');
		expect(chatOptionText({ chat: 'group_1', kind: 'group', id: '1' })).toBe('group_1');
	});
});

describe('chatFieldMode', () => {
	const known = new Set(['group_1', 'friend_2']);

	it('清单为空时只能手填', () => {
		expect(chatFieldMode({ chat: '' }, new Set())).toBe('manual');
		expect(chatFieldMode({ chat: 'group_1' }, new Set())).toBe('manual');
	});

	it('会话在清单里用下拉，空行也用下拉（选号）', () => {
		expect(chatFieldMode({ chat: 'group_1' }, known)).toBe('picker');
		expect(chatFieldMode({ chat: '' }, known)).toBe('picker');
	});

	it('已保存但不在清单里的会话显示成文本框（避免保存时丢值）', () => {
		expect(chatFieldMode({ chat: 'group_999' }, known)).toBe('manual');
	});

	it('用户选了「手动输入…」就保持文本框', () => {
		expect(chatFieldMode({ chat: '', manual: true }, known)).toBe('manual');
		expect(chatFieldMode({ chat: 'group_1', manual: true }, known)).toBe('manual');
	});
});
