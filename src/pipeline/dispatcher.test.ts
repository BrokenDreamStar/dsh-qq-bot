import { describe, expect, it } from 'vitest';
import type { DshQQConfig } from '../config.ts';
import { AccessControl, AdminStore } from './access.ts';
import { Dispatcher } from './dispatcher.ts';
import type { InboundMessage } from '../onebot/events.ts';
import type { MessageLogEntry, MessageLogService } from '../logs/store.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function baseConfig(overrides: Partial<DshQQConfig> = {}): DshQQConfig {
	return {
		transport: 'forward',
		url: '',
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
		wakePrefixes: [],
		messageFilter: [],
		privateNeedsWake: false,
		groupSession: 'shared',
		askUserEnabled: true,
		askUserWaitMs: 300000,
		rateLimit: { windowMs: 60000, max: 0 },
		rosterEnabled: false,
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
		mediaEnabled: false,
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

/** 只关心"到没到 agent"的假会话桥。 */
function harness(config: DshQQConfig, pending?: { accept: (text: string, msg: InboundMessage, woke: boolean) => boolean }) {
	const entries: MessageLogEntry[] = [];
	const enqueued: string[] = [];
	const sent: string[] = [];
	/** 进入聊天记录缓冲的消息（qq_read_history 的数据源）。 */
	const recorded: InboundMessage[] = [];
	/** setReplyContext 的调用记录。 */
	const replyContexts: Array<{ messageId: number | undefined; senderId: string; trigger?: string }> = [];
	const bridge = {
		label: '测试会话',
		mediaDir: '/tmp',
		enqueue: (job: () => Promise<void>) => {
			enqueued.push('job');
			void job;
			return true;
		},
		sendText: async (text: string) => {
			sent.push(text);
		},
		// 记录回复上下文（含触发方式）：出站装饰靠它决定"被 @ 时引用原消息"。
		setReplyContext: (messageId: number | undefined, senderId: string, trigger?: string) => {
			replyContexts.push({ messageId, senderId, trigger });
		},
	};
	const logs = {
		record: (entry: Omit<MessageLogEntry, 'seq' | 'ts'>) => {
			entries.push({ seq: entries.length, ts: 0, ...entry });
		},
	} as unknown as MessageLogService;
	const admins = new AdminStore(config, '/tmp/dshqq-test', logger);
	const dispatcher = new Dispatcher({
		config,
		logger,
		api: {} as never,
		manager: {
			bridgeFor: () => bridge,
			// 有 agent 提问在等回答的会话（默认没有：普通消息不该顺手建立会话桥）。
			getByChatKey: () => (pending === undefined ? undefined : { label: '测试会话', acceptAnswer: pending.accept }),
		} as never,
		admins,
		access: new AccessControl(config, admins),
		store: {} as never,
		roster: { touchGroup: () => {}, renderMentions: async (text: string) => text } as never,
		history: { recordMessage: (msg: InboundMessage) => recorded.push(msg) } as never,
		services: {} as never,
		logs,
		tasks: {} as never,
		runTask: () => {},
		getSelfId: () => '10000',
		setSelfId: () => {},
	});
	const drops = (): string[] => entries.filter((entry) => entry.event === 'drop').map((entry) => entry.text);
	/** 收到的消息在日志里的记录（in 方向，访问控制之前就写下，任何拒绝都不该影响它）。 */
	const inbound = (): string[] => entries.filter((entry) => entry.dir === 'in').map((entry) => entry.text);
	return { dispatcher, enqueued, sent, drops, inbound, entries, recorded, replyContexts };
}

function messageEvent(text: string, type: 'group' | 'private' = 'group', messageId = 1) {
	return {
		post_type: 'message',
		message_type: type,
		self_id: 10000,
		user_id: 12345,
		...(type === 'group' ? { group_id: 888 } : {}),
		message_id: messageId,
		sender: { user_id: 12345, nickname: '张三' },
		message: [{ type: 'text', data: { text } }],
		raw_message: text,
	};
}

/** @机器人 的群消息（mentionMe=true，段里 @ 的是 self_id=10000）。 */
function mentionEvent(text: string, messageId = 1) {
	return {
		...messageEvent('', 'group', messageId),
		message: [
			{ type: 'at', data: { qq: '10000' } },
			{ type: 'text', data: { text } },
		],
		raw_message: `[CQ:at,qq=10000] ${text}`,
	};
}

describe('Dispatcher 信息过滤', () => {
	it('命中过滤前缀：不进 agent、不回提示，只记丢弃原因', async () => {
		const app = harness(baseConfig({ messageFilter: ['#'] }));
		app.dispatcher.handle(messageEvent('#今天的日报'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(0);
		expect(app.sent).toHaveLength(0);
		expect(app.drops()).toEqual(['命中信息过滤前缀「#」，忽略']);
	});

	it('未命中过滤前缀：照常进 agent', async () => {
		const app = harness(baseConfig({ messageFilter: ['#'], groupMentionOnly: false }));
		app.dispatcher.handle(messageEvent('今天的日报'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(1);
		expect(app.drops()).toHaveLength(0);
	});

	it('过滤优先于 @唤醒与 / 指令（连命令也不响应）', async () => {
		const app = harness(baseConfig({ messageFilter: ['#'] }));
		app.dispatcher.handle(messageEvent('#/status'));
		app.dispatcher.handle(messageEvent('#@机器人 帮我看看'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(0);
		expect(app.sent).toHaveLength(0);
		expect(app.drops()).toHaveLength(2);
	});

	it('私聊同样过滤', async () => {
		const app = harness(baseConfig({ messageFilter: ['#'] }));
		app.dispatcher.handle(messageEvent('#悄悄话', 'private'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(0);
		expect(app.drops()).toHaveLength(1);
	});

	it('前缀前有空白也算命中；多个前缀任一命中即可', async () => {
		const app = harness(baseConfig({ messageFilter: ['#', '//'] }));
		app.dispatcher.handle(messageEvent('   #缩进后的井号'));
		app.dispatcher.handle(messageEvent('//注释风格'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(0);
		expect(app.drops()).toHaveLength(2);
	});

	it('仅匹配开头：前缀出现在中间不拦', async () => {
		const app = harness(baseConfig({ messageFilter: ['#'], groupMentionOnly: false }));
		app.dispatcher.handle(messageEvent('帮我看看 #话题'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(1);
	});

	it('列表为空 = 不过滤（默认行为不变）', async () => {
		const app = harness(baseConfig({ messageFilter: [], groupMentionOnly: false }));
		app.dispatcher.handle(messageEvent('#今天的日报'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(1);
		expect(app.drops()).toHaveLength(0);
	});
});

describe('Dispatcher 聊天记录缓冲', () => {
	it('没有唤醒机器人的群消息也进缓冲（agent 之后才读得到上下文）', async () => {
		const app = harness(baseConfig({ groupMentionOnly: true }));
		app.dispatcher.handle(messageEvent('今晚吃什么'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(0);
		expect(app.recorded.map((msg) => msg.plainText)).toEqual(['今晚吃什么']);
	});

	it('机器人自己的消息进缓冲（读取时标记为【你】）', async () => {
		const app = harness(baseConfig({ groupMentionOnly: true }));
		app.dispatcher.handle({ ...messageEvent('我先看看'), user_id: 10000, sender: { user_id: 10000, nickname: '机器人' } });
		await Promise.resolve();
		expect(app.recorded.map((msg) => msg.senderId)).toEqual(['10000']);
	});

	it('命中信息过滤前缀的消息连缓冲都不进（用户明确不想让机器人看到）', async () => {
		const app = harness(baseConfig({ messageFilter: ['#'] }));
		app.dispatcher.handle(messageEvent('#悄悄话'));
		await Promise.resolve();
		expect(app.recorded).toHaveLength(0);
	});

	it('访问控制拒绝的消息不进缓冲', async () => {
		const app = harness(baseConfig({ groupMode: 'allowlist', allowedGroups: [] }));
		app.dispatcher.handle(messageEvent('让我进去'));
		await Promise.resolve();
		expect(app.recorded).toHaveLength(0);
	});

	it('被限速丢弃的消息仍进缓冲（它确实是聊天记录的一部分）', async () => {
		const app = harness(baseConfig({ groupMentionOnly: false, rateLimit: { windowMs: 60000, max: 1 } }));
		app.dispatcher.handle(messageEvent('第一条'));
		app.dispatcher.handle(messageEvent('第二条', 'group', 2));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(1);
		expect(app.recorded.map((msg) => msg.plainText)).toEqual(['第一条', '第二条']);
	});
});

describe('Dispatcher 访问控制拒绝的日志分级', () => {
	const deniedGroup = { groupMode: 'allowlist' as const, allowedGroups: [] };

	it('群聊被拒绝：收到的消息照常记录（in 方向），但不记「访问控制拒绝」', async () => {
		const app = harness(baseConfig({ ...deniedGroup, groupMentionOnly: true }));
		app.dispatcher.handle(messageEvent('今晚吃什么'));
		await Promise.resolve();
		expect(app.inbound()).toEqual(['今晚吃什么']);
		expect(app.enqueued).toHaveLength(0);
		expect(app.recorded).toHaveLength(0);
		expect(app.drops()).toHaveLength(0);
	});

	it('群聊里 @机器人 的消息被拒绝：同样不记 drop（只有 in 记录）', async () => {
		const app = harness(baseConfig({ ...deniedGroup, groupMentionOnly: true }));
		app.dispatcher.handle(mentionEvent('帮我看看这个'));
		await Promise.resolve();
		expect(app.inbound()).toEqual(['帮我看看这个']);
		expect(app.enqueued).toHaveLength(0);
		expect(app.drops()).toHaveLength(0);
	});

	it('群聊里命中唤醒前缀 / 指令的消息被拒绝：同样静默', async () => {
		const app = harness(baseConfig({ ...deniedGroup, groupMentionOnly: true, wakePrefixes: ['小助手'] }));
		app.dispatcher.handle(messageEvent('小助手 在吗'));
		app.dispatcher.handle(messageEvent('/status', 'group', 2));
		await Promise.resolve();
		expect(app.inbound()).toHaveLength(2);
		expect(app.drops()).toHaveLength(0);
	});

	it('黑名单用户的群消息被拒绝：同样静默（in 记录仍在）', async () => {
		const app = harness(baseConfig({ groupMode: 'open', blockedUsers: ['12345'] }));
		app.dispatcher.handle(mentionEvent('帮我看看这个'));
		await Promise.resolve();
		expect(app.inbound()).toHaveLength(1);
		expect(app.drops()).toHaveLength(0);
	});

	it('私聊被拒绝仍然记一条 drop（陌生人私聊值得留痕）', async () => {
		const app = harness(baseConfig({ privateMode: 'allowlist', allowedUsers: [] }));
		app.dispatcher.handle(messageEvent('在吗', 'private'));
		await Promise.resolve();
		expect(app.inbound()).toEqual(['在吗']);
		expect(app.drops()).toEqual(['访问控制拒绝']);
	});

	it('群聊访问通过时行为不变（照常进 agent，无 drop）', async () => {
		const app = harness(baseConfig({ groupMode: 'open', groupMentionOnly: true }));
		app.dispatcher.handle(mentionEvent('帮我看看这个'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(1);
		expect(app.drops()).toHaveLength(0);
	});

	it('@机器人 触发时把「mention」交给桥（出站才会引用原消息）', async () => {
		const app = harness(baseConfig({ groupMode: 'open', groupMentionOnly: true }));
		app.dispatcher.handle(mentionEvent('帮我看看这个', 777));
		await Promise.resolve();
		expect(app.replyContexts).toEqual([{ messageId: 777, senderId: '12345', trigger: 'mention' }]);
	});

	it('唤醒前缀触发时不是 mention（不引用原消息）', async () => {
		const app = harness(baseConfig({ groupMode: 'open', groupMentionOnly: true, wakePrefixes: ['小助手'] }));
		app.dispatcher.handle(messageEvent('小助手 在吗', 'group', 778));
		await Promise.resolve();
		expect(app.replyContexts).toEqual([{ messageId: 778, senderId: '12345', trigger: 'other' }]);
	});
});

describe('Dispatcher 提问的回答', () => {
	it('有提问在等回答时：消息投给桥，不再走唤醒判定（群里不 @ 也算回答）', async () => {
		const calls: Array<{ text: string; woke: boolean }> = [];
		const app = harness(baseConfig({ groupMode: 'open', groupMentionOnly: true }), {
			accept: (text, _msg, woke) => {
				calls.push({ text, woke });
				return true;
			},
		});
		app.dispatcher.handle(messageEvent('2', 'group', 901));
		await Promise.resolve();
		expect(calls).toEqual([{ text: '2', woke: false }]);
		expect(app.enqueued).toHaveLength(0);
		expect(app.drops()).toHaveLength(0);
		// 回答本身仍是聊天记录的一部分（要进缓冲，之后 qq_read_history 读得到）。
		expect(app.recorded.map((msg) => msg.plainText)).toEqual(['2']);
	});

	it('桥没接这条消息（不合群聊应答规则）时原样落回唤醒判定', async () => {
		const app = harness(baseConfig({ groupMode: 'open', groupMentionOnly: true }), { accept: () => false });
		app.dispatcher.handle(messageEvent('2', 'group', 902));
		await Promise.resolve();
		// 没被唤醒的群消息照旧静默丢弃：不进 agent，也不记 drop。
		expect(app.enqueued).toHaveLength(0);
		expect(app.drops()).toHaveLength(0);
		expect(app.inbound()).toEqual(['2']);
	});

	it('命令优先于回答：/op 这类控制指令不会被当成答案', async () => {
		let called = false;
		const app = harness(baseConfig({ groupMode: 'open' }), {
			accept: () => {
				called = true;
				return true;
			},
		});
		app.dispatcher.handle(messageEvent('/op 12345', 'private'));
		await Promise.resolve();
		expect(called).toBe(false);
		expect(app.sent).toEqual(['❌ 该命令仅管理员可用']);
	});

	it('没有提问在等回答时不建立会话桥（普通消息不受影响）', async () => {
		const app = harness(baseConfig({ privateMode: 'open' }));
		app.dispatcher.handle(messageEvent('普通消息', 'private'));
		await Promise.resolve();
		expect(app.enqueued).toHaveLength(1);
	});
});
