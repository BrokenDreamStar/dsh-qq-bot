import { describe, expect, it } from 'vitest';
import {
	ChatHistoryService,
	HISTORY_MAX_CHATS,
	formatEntryTime,
	mergeHistory,
	orderRemoteOldestFirst,
	renderTranscript,
	type ChatHistoryEntry,
	type ChatHistoryDeps,
} from './history.ts';
import type { DshQQConfig } from '../config.ts';
import type { InboundMessage } from './events.ts';
import type { MsgResult } from './api.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function baseConfig(overrides: Partial<DshQQConfig> = {}): DshQQConfig {
	return {
		historyEnabled: true,
		historyMaxMessages: 50,
		historyBufferPerChat: 200,
		historyRemoteFetch: true,
		...overrides,
	} as DshQQConfig;
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	// 文本即段内容：覆盖 text 时同步派生 segments（服务读的是 segments）。
	const text = overrides.text ?? '今晚吃什么';
	return {
		kind: 'message',
		selfId: '99999',
		chatType: 'group',
		chatId: '888',
		groupId: '888',
		senderId: '10001',
		senderName: '张三',
		messageId: 1,
		segments: [{ type: 'text', data: { text } }],
		text,
		plainText: text,
		mentionMe: false,
		hasImage: false,
		time: 1735689600,
		...overrides,
	};
}

function remoteMessage(overrides: Partial<MsgResult> = {}): MsgResult {
	return {
		message_id: 900,
		time: 1735689600,
		sender: { user_id: 10002, nickname: '李四' },
		message: [{ type: 'text', data: { text: '随便' } }],
		...overrides,
	};
}

function service(config: DshQQConfig, api: Partial<ChatHistoryDeps['api']> = {}): ChatHistoryService {
	return new ChatHistoryService({
		api: { getGroupMsgHistory: async () => undefined, getFriendMsgHistory: async () => undefined, ...api },
		config,
		logger,
		getSelfId: () => '99999',
	});
}

const entry = (overrides: Partial<ChatHistoryEntry> = {}): ChatHistoryEntry => ({
	chatType: 'group',
	chatId: '888',
	senderId: '10001',
	senderName: '张三',
	text: '内容',
	timeMs: 1735689600000,
	self: false,
	seq: 0,
	...overrides,
});

describe('ChatHistoryService 本地缓冲', () => {
	it('记录通过访问控制的消息，按会话隔离并按上限裁剪', () => {
		const history = service(baseConfig({ historyBufferPerChat: 2 }));
		history.recordMessage(message({ messageId: 1, text: '一', plainText: '一' }));
		history.recordMessage(message({ messageId: 2, text: '二', plainText: '二' }));
		history.recordMessage(message({ messageId: 3, text: '三', plainText: '三', chatId: '999', groupId: '999' }));
		expect(history.local('group', '888', 10).map((item) => item.text)).toEqual(['一', '二']);
		expect(history.local('group', '999', 10).map((item) => item.text)).toEqual(['三']);
		expect(history.local('private', '888', 10)).toEqual([]);
	});

	it('同一 message_id 重复投递只记一次', () => {
		const history = service(baseConfig());
		history.recordMessage(message({ messageId: 7 }));
		history.recordMessage(message({ messageId: 7 }));
		expect(history.local('group', '888', 10)).toHaveLength(1);
	});

	it('关闭开关或缓冲上限为 0 时不记录', () => {
		const off = service(baseConfig({ historyEnabled: false }));
		off.recordMessage(message());
		expect(off.local('group', '888', 10)).toHaveLength(0);
		const zero = service(baseConfig({ historyBufferPerChat: 0 }));
		zero.recordMessage(message());
		expect(zero.local('group', '888', 10)).toHaveLength(0);
	});

	it('识别机器人自己的发言，并给非文本段占位', () => {
		const history = service(baseConfig());
		history.recordMessage(message({ messageId: 1, senderId: '99999', senderName: '机器人', segments: [{ type: 'image', data: { file: 'x' } }], text: '[图片]', hasImage: true }));
		const [only] = history.local('group', '888', 10);
		expect(only?.self).toBe(true);
		expect(only?.text).toBe('[图片]');
	});

	it('跟踪的会话数超上限时淘汰最久未活跃的会话', () => {
		const history = service(baseConfig());
		for (let index = 0; index < HISTORY_MAX_CHATS + 1; index += 1) {
			history.recordMessage(message({ chatId: `g${index}`, groupId: `g${index}`, messageId: index }));
		}
		expect(history.stats.chats).toBe(HISTORY_MAX_CHATS);
		// 最早的那个会话被淘汰，最新的还在。
		expect(history.local('group', 'g0', 10)).toHaveLength(0);
		expect(history.local('group', `g${HISTORY_MAX_CHATS}`, 10)).toHaveLength(1);
	});

	it('reconfigure 在缓冲上限调小后立即裁剪', () => {
		const config = baseConfig({ historyBufferPerChat: 5 });
		const history = service(config);
		for (let index = 0; index < 5; index += 1) history.recordMessage(message({ messageId: index, text: `第${index}条` }));
		config.historyBufferPerChat = 2;
		history.reconfigure();
		expect(history.local('group', '888', 10).map((item) => item.text)).toEqual(['第3条', '第4条']);
	});
});

describe('ChatHistoryService.read', () => {
	it('本地 + 远端合并：同 message_id 去重且本地条目优先', async () => {
		const history = service(
			baseConfig(),
			{ getGroupMsgHistory: async () => [remoteMessage({ message_id: 1, time: 1735689600 }), remoteMessage({ message_id: 900, time: 1735689601 })] },
		);
		history.recordMessage(message({ messageId: 1, text: '本地版本', time: 1735689600 }));
		const result = await history.read({ chatType: 'group', chatId: '888', count: 10 });
		expect(result.entries.map((item) => item.text)).toEqual(['本地版本', '随便']);
	});

	it('远端失败/不支持时只用本地缓冲（绝不抛错）', async () => {
		const history = service(
			baseConfig(),
			{
				getGroupMsgHistory: async () => {
					throw new Error('不支持的接口');
				},
			},
		);
		history.recordMessage(message({ text: '还在' }));
		const result = await history.read({ chatType: 'group', chatId: '888', count: 10 });
		expect(result.entries.map((item) => item.text)).toEqual(['还在']);
		expect(result.remoteCount).toBe(0);
	});

	it('historyRemoteFetch 关闭时不调用远端接口', async () => {
		let called = 0;
		const history = service(
			baseConfig({ historyRemoteFetch: false }),
			{
				getGroupMsgHistory: async () => {
					called += 1;
					return [];
				},
			},
		);
		history.recordMessage(message());
		await history.read({ chatType: 'group', chatId: '888', count: 10 });
		expect(called).toBe(0);
	});

	it('条数被 historyMaxMessages 夹住，私聊走 get_friend_msg_history', async () => {
		let asked: number | undefined;
		let privateCalled = 0;
		const history = service(
			baseConfig({ historyMaxMessages: 3 }),
			{
				getGroupMsgHistory: async (_id, count) => {
					asked = count;
					return [];
				},
				getFriendMsgHistory: async () => {
					privateCalled += 1;
					return [remoteMessage({ sender: { user_id: 5, nickname: '好友' } })];
				},
			},
		);
		await history.read({ chatType: 'group', chatId: '888', count: 999 });
		expect(asked).toBe(3);
		const result = await history.read({ chatType: 'private', chatId: '5', count: 10 });
		expect(privateCalled).toBe(1);
		expect(result.entries).toHaveLength(1);
	});

	it('远端条目渲染文本、CQ 码兜底与【你】标记', async () => {
		const history = service(
			baseConfig(),
			{
				getGroupMsgHistory: async () => [
					remoteMessage({ message_id: 1, message: '[CQ:image,file=x.jpg]', raw_message: '[CQ:image,file=x.jpg]', sender: { user_id: 10002, card: '李四' } }),
					remoteMessage({ message_id: 2, message: [], raw_message: '', time: 1735689601, sender: { user_id: 99999, nickname: '机器人' } }),
				],
			},
		);
		const result = await history.read({ chatType: 'group', chatId: '888', count: 10 });
		expect(result.entries[0]?.text).toBe('[图片]');
		expect(result.entries[0]?.senderName).toBe('李四');
		expect(result.entries[1]?.self).toBe(true);
		expect(result.entries[1]?.text).toBe('（无内容）');
	});
});

describe('orderRemoteOldestFirst / mergeHistory', () => {
	it('最新在前的远端数组会被反转（按 time 判断）', () => {
		const items = [remoteMessage({ message_id: 2, time: 20 }), remoteMessage({ message_id: 1, time: 10 })];
		expect(orderRemoteOldestFirst(items).map((item) => item.message_id)).toEqual([1, 2]);
	});

	it('已是最旧在前的远端数组保持原顺序；无时间戳时原样返回', () => {
		const ascending = [remoteMessage({ message_id: 1, time: 10 }), remoteMessage({ message_id: 2, time: 20 })];
		expect(orderRemoteOldestFirst(ascending).map((item) => item.message_id)).toEqual([1, 2]);
		const timeless = [remoteMessage({ message_id: 5, time: undefined }), remoteMessage({ message_id: 6, time: undefined })];
		expect(orderRemoteOldestFirst(timeless).map((item) => item.message_id)).toEqual([5, 6]);
	});

	it('按 message_seq 判断顺序（比秒级时间戳可靠）', () => {
		const items = [remoteMessage({ message_id: 90, message_seq: 5, time: 20 }), remoteMessage({ message_id: 91, message_seq: 4, time: 20 })];
		expect(orderRemoteOldestFirst(items).map((item) => item.message_seq)).toEqual([4, 5]);
	});

	it('合并后按时间正序、只保留最新 count 条', () => {
		const local = [entry({ messageId: '3', text: '第三', timeMs: 3000, seq: 3 })];
		const remote = [entry({ messageId: '1', text: '第一', timeMs: 1000 }), entry({ messageId: '2', text: '第二', timeMs: 2000 })];
		expect(mergeHistory(local, remote, 10).map((item) => item.text)).toEqual(['第一', '第二', '第三']);
		expect(mergeHistory(local, remote, 2).map((item) => item.text)).toEqual(['第二', '第三']);
	});
});

describe('renderTranscript', () => {
	it('空记录给出明确说明', () => {
		expect(renderTranscript([], { chatLabel: '群 888 ' })).toContain('没有可读取的聊天记录');
	});

	it('渲染时间、昵称与【你】标记，并解析 @ 提及（都不带 QQ 号）', () => {
		const now = new Date('2025-01-01T12:00:00').getTime();
		const text = renderTranscript(
			[
				entry({ text: '@10002 你觉得呢', timeMs: new Date('2025-01-01T11:30:00').getTime() }),
				entry({ text: '我说了算', senderId: '99999', senderName: '机器人', self: true, timeMs: new Date('2025-01-01T11:31:00').getTime() }),
			],
			{ chatLabel: '群 888 ', nameOf: (userId) => (userId === '10002' ? '李四' : undefined), now },
		);
		expect(text).toContain('[11:30] 张三：@李四 你觉得呢');
		expect(text).toContain('[11:31] 机器人【你】：我说了算');
		// 记录正文里不允许出现号码（模型会照抄进回复）。
		expect(text).not.toMatch(/10001|10002|99999/);
	});

	it('跨天带上月日', () => {
		const now = new Date('2025-01-02T10:00:00').getTime();
		expect(formatEntryTime(new Date('2025-01-01T23:59:00').getTime(), now)).toBe('01-01 23:59');
		expect(formatEntryTime(new Date('2025-01-02T00:01:00').getTime(), now)).toBe('00:01');
	});

	it('超长时从最旧的开始省略，保留最新消息', () => {
		const entries = Array.from({ length: 50 }, (_value, index) =>
			entry({ messageId: String(index), text: `第${index}条消息`, timeMs: 1735689600000 + index * 1000, seq: index }),
		);
		const text = renderTranscript(entries, { chatLabel: '群 888 ', maxChars: 120, now: 1735689600000 });
		expect(text).toContain('第49条消息');
		expect(text).toContain('因长度上限已省略');
		expect(text).not.toContain('第0条消息');
	});
});
