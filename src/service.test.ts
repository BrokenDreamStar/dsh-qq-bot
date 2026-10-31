import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { DshQQBotService } from './service.ts';
import type { OneBotApi } from './onebot/api.ts';
import type { AccessControl } from './pipeline/access.ts';
import type { DshQQConfig } from './config.ts';

function setup(options: { allowed?: boolean; messageId?: number | null; connected?: boolean } = {}) {
	const sent: Array<{ target: unknown; text: string; maxChars: number }> = [];
	const ctx = new Context();
	const service = new DshQQBotService(ctx, {
		api: {
			connected: options.connected ?? true,
			sendText: async (target: unknown, text: string, maxChars: number) => {
				sent.push({ target, text, maxChars });
				return options.messageId === undefined ? 42 : options.messageId;
			},
		} as unknown as OneBotApi,
		access: { checkPrivate: () => options.allowed ?? true, checkGroup: () => options.allowed ?? true } as unknown as AccessControl,
		config: { replyMaxChars: 4500 } as DshQQConfig,
	});
	return { ctx, service, sent };
}

describe('DshQQBotService 插件间组合面', () => {
	it('注册为 dshQQBot 服务并复用 QQ 发送管线', async () => {
		const app = setup();
		// Cordis 返回带追踪能力的服务代理，不要求与构造实例严格同引用。
		expect(app.ctx.dshQQBot.connected).toBe(true);
		expect(app.service.connected).toBe(true);
		await expect(app.service.sendText({ chatType: 'group', groupId: '648399497' }, '提醒')).resolves.toEqual({ messageId: 42 });
		expect(app.sent).toEqual([{ target: { chatType: 'group', groupId: '648399497' }, text: '提醒', maxChars: 4500 }]);
	});

	it('主动发送不能绕过 QQ 插件的访问控制', async () => {
		const app = setup({ allowed: false });
		await expect(app.service.sendText({ chatType: 'private', userId: '12345' }, '提醒')).rejects.toThrow('访问控制');
		expect(app.sent).toEqual([]);
	});

	it('发送未获确认时如实返回 null，供调用方重试', async () => {
		const app = setup({ messageId: null });
		await expect(app.service.sendText({ chatType: 'private', userId: '12345' }, '提醒')).resolves.toEqual({ messageId: null });
	});

	it('断线或非法 QQ 号时不进入发送管线', async () => {
		const offline = setup({ connected: false });
		await expect(offline.service.sendText({ chatType: 'private', userId: '12345' }, '提醒')).rejects.toThrow('未连接');
		expect(offline.sent).toEqual([]);

		const invalid = setup();
		await expect(invalid.service.sendText({ chatType: 'group', groupId: 'not-a-number' }, '提醒')).rejects.toThrow('无效的 QQ 群号');
		expect(invalid.sent).toEqual([]);
	});

	it('消息处理器可消费或放行，并提供注销函数', async () => {
		const app = setup();
		const dispose = app.service.onMessage((message) => message.text === '#峰谷时段');
		await expect(app.service.dispatchMessage({ chatType: 'private', chatId: '1', senderId: '1', senderName: '甲', text: '#峰谷时段', mentionMe: false, time: 0 })).resolves.toBe(true);
		await expect(app.service.dispatchMessage({ chatType: 'private', chatId: '1', senderId: '1', senderName: '甲', text: '普通消息', mentionMe: false, time: 0 })).resolves.toBe(false);
		dispose();
		await expect(app.service.dispatchMessage({ chatType: 'private', chatId: '1', senderId: '1', senderName: '甲', text: '#峰谷时段', mentionMe: false, time: 0 })).resolves.toBe(false);
	});
});
