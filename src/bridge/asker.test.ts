import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageLogEntry } from '../logs/store.ts';
import type { OBSegment } from '../onebot/segments.ts';
import { QuestionRelay, type QuestionRelayDeps } from './asker.ts';
import type { AskQuestion } from './ask.ts';

type LogInput = Omit<MessageLogEntry, 'seq' | 'ts'>;

const twoOptions: AskQuestion = {
	id: 'topic',
	question: '想了解哪方面？',
	options: [{ label: '解释' }, { label: '故事' }],
};

function makeRelay(overrides: Partial<QuestionRelayDeps> = {}) {
	const sent: OBSegment[][] = [];
	const logs: LogInput[] = [];
	const warnings: string[] = [];
	const deps: QuestionRelayDeps = {
		label: '用户 1001',
		chatType: 'private',
		chatId: '1001',
		send: async (segments) => {
			sent.push(segments);
			return 900 + sent.length;
		},
		options: () => ({ askUserWaitMs: 300_000, maxTurnMs: 600_000, replyMaxChars: 4500 }),
		askerId: () => '1001',
		logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
		logs: { record: (entry: LogInput) => logs.push(entry) },
		...overrides,
	};
	return { relay: new QuestionRelay(deps), sent, logs, warnings };
}

/** 推进计时器并冲刷微任务（让 send 完成、进入等待）。 */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(1);
}

describe('提问中继', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('发问题 → 收回答：序号解析成选项标签，答案按缝隙形状返回', async () => {
		const { relay, sent, logs } = makeRelay();
		const promise = relay.relay([twoOptions]);
		await flush();
		expect(relay.busy).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.[0]).toMatchObject({ type: 'text' });
		expect((sent[0]?.[0]?.data as { text: string }).text).toContain('想了解哪方面？');

		expect(relay.answer('2', { senderId: '1001', senderName: '张三' })).toBe(true);
		const outcome = await promise;
		expect(outcome).toEqual({ kind: 'answer', answer: { answers: [{ id: 'topic', selected: ['故事'] }] } });
		expect(relay.busy).toBe(false);
		expect(logs.map((entry) => entry.event)).toEqual(['ask', 'ask-answer']);
		expect(logs[1]?.dir).toBe('in');
	});

	it('多题串行：答完第一题才发第二题，未答的题按"跳过"补齐', async () => {
		const { relay, sent } = makeRelay();
		const second: AskQuestion = { id: 'name', question: '怎么称呼？' };
		const promise = relay.relay([twoOptions, second]);
		await flush();
		expect(sent).toHaveLength(1);
		relay.answer('解释', { senderId: '1001', senderName: '张三' });
		await flush();
		expect(sent).toHaveLength(2);
		expect((sent[1]?.[0]?.data as { text: string }).text).toContain('2/2');
		// 第二题在预算内没等到回答：已答的保留，没来得及问的按"跳过"补齐。
		await vi.advanceTimersByTimeAsync(300_000);
		expect(await promise).toEqual({
			kind: 'answer',
			answer: { answers: [{ id: 'topic', selected: ['解释'] }, { id: 'name', selected: [] }] },
		});
	});

	it('跳过关键词 → selected 为空（与 WebUI 的"跳过本题"同形状）', async () => {
		const { relay } = makeRelay();
		const promise = relay.relay([twoOptions]);
		await flush();
		relay.answer('跳过', { senderId: '1001', senderName: '张三' });
		expect(await promise).toEqual({ kind: 'answer', answer: { answers: [{ id: 'topic', selected: [] }] } });
	});

	it('自由文本 → custom', async () => {
		const { relay } = makeRelay();
		const promise = relay.relay([twoOptions]);
		await flush();
		relay.answer('给我讲讲它的来历', { senderId: '1001', senderName: '张三' });
		expect(await promise).toEqual({
			kind: 'answer',
			answer: { answers: [{ id: 'topic', selected: [], custom: '给我讲讲它的来历' }] },
		});
	});

	it('群里 @ 提问的触发者（首块），私聊不加 @', async () => {
		const group = makeRelay({ chatType: 'group', chatId: '555', askerId: () => '1001' });
		const promise = group.relay.relay([twoOptions]);
		await flush();
		expect(group.sent[0]?.[0]).toMatchObject({ type: 'at', data: { qq: '1001' } });
		group.relay.answer('1', { senderId: '1001', senderName: '张三' });
		await promise;

		const priv = makeRelay();
		const privPromise = priv.relay.relay([twoOptions]);
		await flush();
		expect(priv.sent[0]?.[0]?.type).toBe('text');
		priv.relay.answer('1', { senderId: '1001', senderName: '张三' });
		await privPromise;
	});

	it('超时（一题都没答）：返回 timeout 并留一条 ask-timeout 日志', async () => {
		const { relay, logs } = makeRelay();
		const promise = relay.relay([twoOptions]);
		await flush();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(await promise).toEqual({ kind: 'timeout', budgetMs: 300000 });
		expect(logs.map((entry) => entry.event)).toEqual(['ask', 'ask-timeout']);
		expect(relay.busy).toBe(false);
	});

	it('signal 中止（本轮取消/桥销毁）→ 立刻返回 aborted，不等满预算', async () => {
		const controller = new AbortController();
		const { relay } = makeRelay();
		const promise = relay.relay([twoOptions], controller.signal);
		await flush();
		controller.abort();
		expect(await promise).toEqual({ kind: 'aborted' });
	});

	it('cancel() 同样中止等待（下游应答器已经答了）', async () => {
		const { relay } = makeRelay();
		const promise = relay.relay([twoOptions]);
		await flush();
		relay.cancel();
		expect(await promise).toEqual({ kind: 'aborted' });
	});

	it('取消落在"发送中"窗口里也算数（下游抢答早于等待建立）', async () => {
		let self: QuestionRelay | undefined;
		const { relay } = makeRelay({
			send: async () => {
				self?.cancel();
				return 901;
			},
		});
		self = relay;
		expect(await relay.relay([twoOptions])).toEqual({ kind: 'aborted' });
	});

	it('一条都没发出去（transport 断开）→ undeliverable，不空等回复', async () => {
		const { relay, warnings } = makeRelay({ send: async () => null });
		expect(await relay.relay([twoOptions])).toEqual({ kind: 'undeliverable' });
		expect(warnings).toHaveLength(1);
	});

	it('没有在等回答时投递返回 false（消息落回普通管线）', async () => {
		const { relay } = makeRelay();
		expect(relay.answer('1', { senderId: '1001', senderName: '张三' })).toBe(false);
	});

	it('长问题按单条上限切块，且所有块 id 都记入引用判定', async () => {
		const long: AskQuestion = { id: 'plan', question: '批准吗？', detail: 'x'.repeat(200) };
		const { relay, sent } = makeRelay({
			options: () => ({ askUserWaitMs: 300_000, maxTurnMs: 600_000, replyMaxChars: 80 }),
		});
		const promise = relay.relay([long]);
		await flush();
		expect(sent.length).toBeGreaterThan(1);
		expect(relay.questionMessageIds.length).toBe(sent.length);
		relay.answer('1', { senderId: '1001', senderName: '张三' });
		await promise;
	});

	it('预算夹取依赖单轮上限（maxTurnMs 很短时等待也短）', async () => {
		const { relay, logs } = makeRelay({
			options: () => ({ askUserWaitMs: 300_000, maxTurnMs: 20_000, replyMaxChars: 4500 }),
		});
		const promise = relay.relay([twoOptions]);
		await flush();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await promise).toEqual({ kind: 'timeout', budgetMs: 10_000 });
		expect(logs.at(-1)?.text).toContain('10s');
	});
});
