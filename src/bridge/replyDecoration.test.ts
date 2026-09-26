/**
 * 出站装饰回归：**群聊里被 @ 触发时用 QQ 的引用回复引用那条 @ 消息**
 * （用户明确要求），并且不再重复 @ 一次；定时任务的主动消息不带引用。
 *
 * 用最小桥 + 假 api 验证实际发出去的段数组：装饰只加在第一块上。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatBridge } from './chat.ts';
import { ChatSessionStore } from './sessionStore.ts';
import type { DshQQConfig } from '../config.ts';
import type { DshServices } from '../dsh.ts';
import type { PersonaStore } from '../persona/store.ts';
import type { Logger } from '../types.ts';
import type { OBSegment } from '../onebot/segments.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Harness {
	bridge: ChatBridge;
	/** 每次 sendSegments 收到的段数组（按发送顺序）。 */
	sent: OBSegment[][];
}

function harness(overrides: Partial<DshQQConfig> = {}, scope: 'group' | 'private' = 'group'): Harness {
	const chatId = '888';
	const key = scope === 'private' ? `u-${chatId}` : `g-${chatId}`;
	const config = {
		groupSession: 'shared',
		replyWithQuote: false,
		replyQuoteOnMention: true,
		replyWithMention: false,
		foldForward: false,
		foldThreshold: 0,
		replyMaxChars: 4500,
		...overrides,
	} as unknown as DshQQConfig;
	const sent: OBSegment[][] = [];
	const api = {
		sendSegments: async (_target: unknown, segments: OBSegment[]) => {
			sent.push(segments);
			return 1000 + sent.length;
		},
	};
	const sessionDir = mkdtempSync(join(tmpdir(), 'dshqq-decor-'));
	const bridge = new ChatBridge({
		key,
		scope,
		chatId,
		senderId: '2043598920',
		senderName: '碎梦星尘Star',
		sessionDir,
		agentCwd: sessionDir,
		groupName: `Group_${chatId}`,
		mediaDir: join(sessionDir, 'media', key),
		api: api as never,
		config,
		services: { agentDefaultModel: { currentSelection: () => ({ provider: 'dsh', model: 'base' }) }, agents: {} } as unknown as DshServices,
		store: { getChatModel: () => undefined, defaultModel: () => undefined, resolve: () => ({ name: 'default', prompt: '' }) } as unknown as PersonaStore,
		roster: {} as never,
		admins: {} as never,
		logger,
		sessions: ChatSessionStore.load(mkdtempSync(join(tmpdir(), 'dshqq-decor-sessions-'))),
		getSelfId: () => '2854203783',
	});
	return { bridge, sent };
}

const replySegments = (sent: OBSegment[][]): OBSegment[] => sent[0] ?? [];

describe('出站装饰：被 @ 触发时引用原消息', () => {
	it('群聊 @ 触发 → 引用那条消息，且不再追加 @ 段', async () => {
		const { bridge, sent } = harness();
		bridge.setReplyContext(4242, '2043598920', 'mention');
		await bridge.reply('我觉得可以');
		expect(replySegments(sent)).toEqual([
			{ type: 'reply', data: { id: '4242' } },
			{ type: 'text', data: { text: '我觉得可以' } },
		]);
	});

	it('开启「回复 @ 触发者」时，被 @ 触发也只引用、不重复 @', async () => {
		const { bridge, sent } = harness({ replyWithMention: true });
		bridge.setReplyContext(4242, '2043598920', 'mention');
		await bridge.reply('好');
		expect(replySegments(sent).some((segment) => segment.type === 'at')).toBe(false);
		expect(replySegments(sent)[0]).toEqual({ type: 'reply', data: { id: '4242' } });
	});

	it('关掉 replyQuoteOnMention 后，@ 触发不再引用（回到旧行为）', async () => {
		const { bridge, sent } = harness({ replyQuoteOnMention: false });
		bridge.setReplyContext(4242, '2043598920', 'mention');
		await bridge.reply('好');
		expect(replySegments(sent)).toEqual([{ type: 'text', data: { text: '好' } }]);
	});

	it('唤醒前缀触发（非 @）不引用——只 @ 的场景才是引用回复', async () => {
		const { bridge, sent } = harness();
		bridge.setReplyContext(4242, '2043598920', 'other');
		await bridge.reply('好');
		expect(replySegments(sent)).toEqual([{ type: 'text', data: { text: '好' } }]);
	});

	it('前缀触发 + replyWithMention 开启时仍 @ 触发者（不引用）', async () => {
		const { bridge, sent } = harness({ replyWithMention: true });
		bridge.setReplyContext(4242, '2043598920', 'other');
		await bridge.reply('好');
		expect(replySegments(sent)).toEqual([
			{ type: 'at', data: { qq: '2043598920' } },
			{ type: 'text', data: { text: '好' } },
		]);
	});

	it('replyWithQuote 开启时任何触发都引用（旧开关语义不变）', async () => {
		const { bridge, sent } = harness({ replyWithQuote: true });
		bridge.setReplyContext(4242, '2043598920', 'other');
		await bridge.reply('好');
		expect(replySegments(sent)[0]).toEqual({ type: 'reply', data: { id: '4242' } });
	});

	it('私聊不因 @ 引用（私聊没有 @ 语义）', async () => {
		const { bridge, sent } = harness({}, 'private');
		bridge.setReplyContext(4242, '2043598920', 'mention');
		await bridge.reply('好');
		expect(replySegments(sent)).toEqual([{ type: 'text', data: { text: '好' } }]);
	});

	it('引用段只加在第一块，后续块是纯文本', async () => {
		const { bridge, sent } = harness({ replyMaxChars: 4 });
		bridge.setReplyContext(4242, '2043598920', 'mention');
		await bridge.reply('一二三四五六七八');
		expect(sent).toHaveLength(2);
		expect(sent[0]?.[0]).toEqual({ type: 'reply', data: { id: '4242' } });
		expect(sent[1]).toEqual([{ type: 'text', data: { text: '五六七八' } }]);
	});

	it('定时任务的主动消息不带引用（清掉上一轮上下文）', async () => {
		const { bridge, sent } = harness();
		bridge.setReplyContext(4242, '2043598920', 'mention');
		// 没有 agent 服务，定时任务轮次会在 runTurn 处失败；这里只关心它
		// 开头的"清上下文"是否生效——随后模拟任务自己回一句，必须没有引用段。
		await bridge.handleScheduledTask({
			id: 't1',
			chatKey: 'g-888',
			prompt: '提醒喝水',
			schedule: { kind: 'once', at: Date.now() - 1000 },
			enabled: true,
			createdAt: Date.now(),
			createdBy: '2043598920',
			nextRunAt: Date.now(),
		} as never).catch(() => {});
		await bridge.reply('该喝水了');
		expect(sent.flat().filter((segment) => segment.type === 'reply')).toEqual([]);
	});
});
