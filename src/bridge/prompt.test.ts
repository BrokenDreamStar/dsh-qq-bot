import { describe, expect, it } from 'vitest';
import { buildQuotedBlock, resolveQuoted } from './prompt.ts';
import type { MsgResult } from '../onebot/api.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('buildQuotedBlock', () => {
	it('渲染为单行引用块（只写昵称，不写号码）', () => {
		const block = buildQuotedBlock({ senderId: '67890', senderName: '李四', text: '明天开会' });
		expect(block).toBe('[回复 李四 的消息：明天开会]');
		expect(block).not.toContain('67890');
	});

	it('去除尾部空白', () => {
		const block = buildQuotedBlock({ senderId: '1', senderName: 'A', text: '内容\n' });
		expect(block).toBe('[回复 A 的消息：内容]');
	});
});

describe('resolveQuoted', () => {
	it('从段数组消息反查原文与发送者（群名片优先）', async () => {
		const api = {
			getMsg: async (): Promise<MsgResult | undefined> => ({
				message_id: 30,
				message: [
					{ type: 'text', data: { text: '今天' } },
					{ type: 'image', data: { file: 'a.jpg' } },
				],
				sender: { user_id: 67890, nickname: '李四啊', card: '李总' },
			}),
		};
		const quoted = await resolveQuoted({ api: api as never, replyMessageId: '30', maxChars: 500, logger });
		expect(quoted).toEqual({ senderId: '67890', senderName: '李总', text: '今天[图片]' });
	});

	it('CQ 码字符串兜底', async () => {
		const api = {
			getMsg: async (): Promise<MsgResult | undefined> => ({
				message_id: 31,
				message: '[CQ:at,qq=10000] 收到',
				raw_message: '[CQ:at,qq=10000] 收到',
				sender: { user_id: 1, nickname: '张三' },
			}),
		};
		const quoted = await resolveQuoted({ api: api as never, replyMessageId: '31', maxChars: 500, logger });
		expect(quoted?.text).toBe('@10000 收到');
	});

	it('超长原文按 maxChars 截断', async () => {
		const api = {
			getMsg: async (): Promise<MsgResult | undefined> => ({
				message_id: 32,
				message: [{ type: 'text', data: { text: 'x'.repeat(100) } }],
				sender: { user_id: 1, nickname: '张三' },
			}),
		};
		const quoted = await resolveQuoted({ api: api as never, replyMessageId: '32', maxChars: 10, logger });
		expect(quoted?.text).toHaveLength(10);
	});

	it('反查失败或空原文返回 undefined', async () => {
		const missing = { getMsg: async (): Promise<MsgResult | undefined> => undefined };
		expect(await resolveQuoted({ api: missing as never, replyMessageId: '404', maxChars: 500, logger })).toBeUndefined();
		const empty = { getMsg: async (): Promise<MsgResult | undefined> => ({ message_id: 5 }) };
		expect(await resolveQuoted({ api: empty as never, replyMessageId: '5', maxChars: 500, logger })).toBeUndefined();
	});

	it('无引用 id 直接返回 undefined（不发请求）', async () => {
		let called = 0;
		const api = {
			getMsg: async (): Promise<MsgResult | undefined> => {
				called += 1;
				return undefined;
			},
		};
		expect(await resolveQuoted({ api: api as never, maxChars: 500, logger })).toBeUndefined();
		expect(called).toBe(0);
	});
});
