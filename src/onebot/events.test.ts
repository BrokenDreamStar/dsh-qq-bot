import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './events.ts';

describe('normalizeEvent', () => {
	it('群消息（段数组）', () => {
		const event = normalizeEvent({
			post_type: 'message',
			message_type: 'group',
			self_id: 10000,
			user_id: 12345,
			group_id: 888,
			message_id: 42,
			time: 1700000000,
			sender: { user_id: 12345, nickname: '张三', card: '三三' },
			message: [
				{ type: 'reply', data: { id: '30' } },
				{ type: 'at', data: { qq: '10000' } },
				{ type: 'text', data: { text: ' 怎么看？' } },
				{ type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
			],
		});
		expect(event).toMatchObject({
			kind: 'message',
			chatType: 'group',
			chatId: '888',
			senderId: '12345',
			senderName: '三三',
			messageId: 42,
			mentionMe: true,
			replyMessageId: '30',
			hasImage: true,
		});
		if (event?.kind === 'message') expect(event.text).toBe('怎么看？[图片]');
	});

	it('私聊消息（CQ 码兜底）', () => {
		const event = normalizeEvent({
			post_type: 'message',
			message_type: 'private',
			self_id: 10000,
			user_id: 777,
			message_id: 43,
			message: '[CQ:image,file=b.jpg]',
			raw_message: '[CQ:image,file=b.jpg]',
		});
		expect(event).toMatchObject({ kind: 'message', chatType: 'private', chatId: '777', hasImage: true, senderName: '777' });
	});

	it('自己发的消息照常归一化（由 dispatcher 防环）', () => {
		const event = normalizeEvent({
			post_type: 'message',
			message_type: 'private',
			self_id: 10000,
			user_id: 10000,
			message_id: 44,
			message: [{ type: 'text', data: { text: 'hi' } }],
		});
		expect(event).toMatchObject({ kind: 'message', senderId: '10000' });
	});

	it('戳一戳（群）', () => {
		const event = normalizeEvent({
			post_type: 'notice',
			notice_type: 'notify',
			sub_type: 'poke',
			self_id: 10000,
			group_id: 888,
			user_id: 12345,
			target_id: 10000,
		});
		expect(event).toEqual({
			kind: 'poke',
			selfId: '10000',
			chatType: 'group',
			groupId: '888',
			senderId: '12345',
			targetId: '10000',
		});
	});

	it('好友请求与加群请求', () => {
		const friend = normalizeEvent({
			post_type: 'request',
			request_type: 'friend',
			self_id: 10000,
			user_id: 555,
			flag: 'f1',
			comment: '加个好友',
			sender: { nickname: '新朋友' },
		});
		expect(friend).toMatchObject({ kind: 'friendRequest', userId: '555', flag: 'f1' });
		const group = normalizeEvent({
			post_type: 'request',
			request_type: 'group',
			self_id: 10000,
			group_id: 888,
			user_id: 555,
			flag: 'g1',
			sub_type: 'invite',
		});
		expect(group).toMatchObject({ kind: 'groupRequest', groupId: '888', subType: 'invite' });
	});

	it('无关 notice 返回 null', () => {
		expect(normalizeEvent({ post_type: 'notice', notice_type: 'group_increase', self_id: 10000 })).toBeNull();
		expect(normalizeEvent({})).toBeNull();
	});
});
