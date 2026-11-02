import { describe, expect, it } from 'vitest';
import { OneBotApi } from './api.ts';
import type { OneBotTransport } from '../transport/base.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** 记录调用参数的假传输层。 */
function fakeTransport(data: unknown, error?: Error): { transport: OneBotTransport; calls: Array<{ action: string; params: Record<string, unknown> }> } {
	const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
	return {
		calls,
		transport: {
			kind: 'forward',
			connected: true,
			start: () => {},
			stop: () => {},
			call: (action, params = {}) => {
				calls.push({ action, params });
				return error === undefined ? Promise.resolve(data) : Promise.reject(error);
			},
		},
	};
}

describe('OneBotApi 历史消息', () => {
	it('get_group_msg_history：传 group_id/count/message_seq，解析 messages 数组', async () => {
		const { transport, calls } = fakeTransport({
			messages: [
				{ message_id: 12, message_seq: 5, time: 1735689600, sender: { user_id: 10001, nickname: '张三', card: '三儿' }, message: [{ type: 'text', data: { text: '在吗' } }] },
			],
		});
		const api = new OneBotApi(transport, logger);
		const list = await api.getGroupMsgHistory('888', 20);
		expect(calls[0]).toEqual({ action: 'get_group_msg_history', params: { group_id: '888', count: 20, message_seq: 0 } });
		expect(list).toHaveLength(1);
		expect(list?.[0]).toMatchObject({ message_id: 12, message_seq: 5, time: 1735689600, raw_message: undefined });
		expect(list?.[0]?.sender?.card).toBe('三儿');
	});

	it('get_friend_msg_history：传 user_id，兼容 { message: [...] } 与裸数组两种返回', async () => {
		const wrapped = fakeTransport({ message: [{ message_id: 1, sender: { user_id: 5 } }] });
		const apiWrapped = new OneBotApi(wrapped.transport, logger);
		expect(await apiWrapped.getFriendMsgHistory('5', 10)).toHaveLength(1);
		expect(wrapped.calls[0]?.params).toEqual({ user_id: '5', count: 10, message_seq: 0 });

		const bare = fakeTransport([{ message_id: 2 }, { message_id: 3 }]);
		const apiBare = new OneBotApi(bare.transport, logger);
		expect((await apiBare.getGroupMsgHistory('888', 5))?.map((item) => item.message_id)).toEqual([2, 3]);
	});

	it('缺 message_id 的条目被丢弃（无法去重/引用）', async () => {
		const { transport } = fakeTransport({ messages: [{ sender: { user_id: 1 } }, { message_id: 9 }] });
		const api = new OneBotApi(transport, logger);
		expect((await api.getGroupMsgHistory('888', 5))?.map((item) => item.message_id)).toEqual([9]);
	});

	it('接口失败或返回形态不认识时返回 undefined（调用方回退本地缓冲）', async () => {
		const failing = new OneBotApi(fakeTransport(undefined, new Error('retcode 1200')).transport, logger);
		expect(await failing.getGroupMsgHistory('888', 5)).toBeUndefined();
		const unknown = new OneBotApi(fakeTransport({ ok: true }).transport, logger);
		expect(await unknown.getGroupMsgHistory('888', 5)).toBeUndefined();
	});
});

describe('OneBotApi 群 / 好友清单（会话下拉用）', () => {
	it('get_group_list：号码转字符串，缺 group_name 时留空，缺号码的条目丢弃', async () => {
		const { transport, calls } = fakeTransport([
			{ group_id: 648399497, group_name: '摸鱼群' },
			{ group_id: '123', group_name: undefined },
			{ group_name: '没有号码' },
		]);
		const api = new OneBotApi(transport, logger);
		expect(await api.listGroups()).toEqual([
			{ id: '648399497', name: '摸鱼群' },
			{ id: '123', name: '' },
		]);
		expect(calls[0]?.action).toBe('get_group_list');
	});

	it('get_friend_list：备注优先、其次昵称', async () => {
		const { transport } = fakeTransport([
			{ user_id: 1, nickname: '小明', remark: '同事' },
			{ user_id: 2, nickname: '小红', remark: '  ' },
		]);
		const api = new OneBotApi(transport, logger);
		expect(await api.listFriends()).toEqual([
			{ id: '1', name: '同事' },
			{ id: '2', name: '小红' },
		]);
	});

	it('对接端不支持 / 调用失败时返回 undefined（设置页退化为本地清单）', async () => {
		const failing = new OneBotApi(fakeTransport(undefined, new Error('unsupported action')).transport, logger);
		expect(await failing.listGroups()).toBeUndefined();
		expect(await failing.listFriends()).toBeUndefined();
		const unknown = new OneBotApi(fakeTransport({ ok: true }).transport, logger);
		expect(await unknown.listGroups()).toBeUndefined();
	});

	it('未连接时不发 action（离线打开设置页是常态）', async () => {
		const calls: string[] = [];
		const transport: OneBotTransport = {
			kind: 'forward',
			connected: false,
			start: () => {},
			stop: () => {},
			call: (action) => {
				calls.push(action);
				return Promise.reject(new Error('onebot not connected'));
			},
		};
		const api = new OneBotApi(transport, logger);
		expect(await api.listGroups()).toBeUndefined();
		expect(await api.listFriends()).toBeUndefined();
		expect(calls).toEqual([]);
	});
});
