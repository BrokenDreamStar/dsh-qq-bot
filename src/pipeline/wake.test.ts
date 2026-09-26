import { describe, expect, it } from 'vitest';
import type { DshQQConfig } from '../config.ts';
import { normalizeEvent, type InboundMessage, type RawEvent } from '../onebot/events.ts';
import { evaluateWake, matchMessageFilter } from './wake.ts';

function baseConfig(overrides: Partial<DshQQConfig> = {}): DshQQConfig {
	return {
		transport: 'forward',
		url: 'ws://127.0.0.1:3001',
		reversePort: 6199,
		reversePath: '/ws',
		accessToken: '',
		reconnectDelayMs: 3000,
		httpTimeoutMs: 15000,
		privateMode: 'open',
		groupMode: 'open',
		allowedUsers: [],
		allowedGroups: [],
		blockedUsers: [],
		blockedGroups: [],
		adminUsers: [],
		adminUsersFile: '',
		groupMentionOnly: true,
		wakePrefixes: ['小助手'],
		privateNeedsWake: false,
		groupSession: 'shared',
		rateLimit: { windowMs: 60000, max: 30 },
		rosterEnabled: true,
		rosterTtlMs: 21600000,
		rosterMaxMembers: 60,
		quoteMaxChars: 500,
		restrictTools: true,
		userTools: [],
		blockedTools: [],
		replyMaxChars: 4500,
		foldForward: true,
		foldThreshold: 4000,
		replyQuoteOnMention: false,
		replyWithQuote: false,
		replyWithMention: false,
		mediaEnabled: true,
		mediaMaxMB: 20,
		pokeReply: '',
		autoApproveRequests: false,
		preset: '',
		workspaceRoot: '',
		sessionGroupRoot: '',
		workspaceMode: 'chat',
		dataDir: '',
		maxTurnMs: 600000,
		sessionIdleTimeoutMs: 1800000,
		maxQueue: 20,
		registerSendTools: true,
		debug: false,
		...overrides,
	};
}

function groupMessage(overrides: Partial<RawEvent> = {}): InboundMessage {
	const raw: RawEvent = {
		post_type: 'message',
		message_type: 'group',
		self_id: 10000,
		user_id: 12345,
		group_id: 888,
		message_id: 1,
		sender: { user_id: 12345, nickname: '张三' },
		message: [{ type: 'text', data: { text: '你好' } }],
		raw_message: '你好',
		...overrides,
	};
	const event = normalizeEvent(raw);
	if (event === null || event.kind !== 'message') throw new Error('normalize failed');
	return event;
}

describe('evaluateWake', () => {
	it('群聊 @机器人 触发并剥离 @段', () => {
		const msg = groupMessage({
			message: [
				{ type: 'at', data: { qq: '10000' } },
				{ type: 'text', data: { text: ' 帮我查天气' } },
			],
		});
		const wake = evaluateWake(msg, baseConfig());
		expect(wake.woke).toBe(true);
		expect(wake.via).toBe('mention');
		expect(wake.text).toBe('帮我查天气');
	});

	it('群聊唤醒前缀触发', () => {
		const msg = groupMessage({ message: [{ type: 'text', data: { text: '小助手讲个笑话' } }] });
		const wake = evaluateWake(msg, baseConfig());
		expect(wake.woke).toBe(true);
		expect(wake.via).toBe('prefix');
		expect(wake.text).toBe('讲个笑话');
	});

	it('群聊指令始终唤醒（mentionOnly 下同样生效）', () => {
		const msg = groupMessage({ message: [{ type: 'text', data: { text: '/status' } }] });
		const wake = evaluateWake(msg, baseConfig({ groupMentionOnly: true }));
		expect(wake.woke).toBe(true);
		expect(wake.via).toBe('command');
	});

	it('mentionOnly 下普通群消息不触发', () => {
		const wake = evaluateWake(groupMessage(), baseConfig());
		expect(wake.woke).toBe(false);
	});

	it('关闭 mentionOnly 后普通消息触发', () => {
		const wake = evaluateWake(groupMessage(), baseConfig({ groupMentionOnly: false }));
		expect(wake.woke).toBe(true);
		expect(wake.via).toBe('always');
	});

	it('私聊默认触发', () => {
		const raw: RawEvent = {
			post_type: 'message',
			message_type: 'private',
			self_id: 10000,
			user_id: 12345,
			message_id: 2,
			message: [{ type: 'text', data: { text: '在吗' } }],
		};
		const event = normalizeEvent(raw);
		if (event === null || event.kind !== 'message') throw new Error('normalize failed');
		const wake = evaluateWake(event, baseConfig());
		expect(wake.woke).toBe(true);
		expect(wake.text).toBe('在吗');
	});

	it('私聊需要唤醒时前缀触发', () => {
		const raw: RawEvent = {
			post_type: 'message',
			message_type: 'private',
			self_id: 10000,
			user_id: 12345,
			message_id: 3,
			message: [{ type: 'text', data: { text: '小助手在吗' } }],
		};
		const event = normalizeEvent(raw);
		if (event === null || event.kind !== 'message') throw new Error('normalize failed');
		const config = baseConfig({ privateNeedsWake: true });
		expect(evaluateWake(event, config).woke).toBe(true);
		const noPrefix = normalizeEvent({ ...raw, message: [{ type: 'text', data: { text: '在吗' } }] });
		if (noPrefix === null || noPrefix.kind !== 'message') throw new Error('normalize failed');
		expect(evaluateWake(noPrefix, config).woke).toBe(false);
	});
});

describe('matchMessageFilter', () => {
	it('命中开头前缀时返回该前缀', () => {
		expect(matchMessageFilter('#今天的日报', ['#'])).toBe('#');
		expect(matchMessageFilter('/status', ['/'])).toBe('/');
	});

	it('前缀在中间或不在开头 = 不命中', () => {
		expect(matchMessageFilter('帮我看看 #话题', ['#'])).toBeUndefined();
		expect(matchMessageFilter('', ['#'])).toBeUndefined();
	});

	it('开头的空白被忽略；大小写不折叠', () => {
		expect(matchMessageFilter('  #缩进', ['#'])).toBe('#');
		expect(matchMessageFilter('abc', ['A'])).toBeUndefined();
	});

	it('多条前缀任一命中即可；空串前缀忽略', () => {
		expect(matchMessageFilter('//注释', ['#', '//'])).toBe('//');
		expect(matchMessageFilter('随便说说', ['', '#'])).toBeUndefined();
	});

	it('前缀列表为空 = 恒不命中', () => {
		expect(matchMessageFilter('#随便', [])).toBeUndefined();
	});
});
