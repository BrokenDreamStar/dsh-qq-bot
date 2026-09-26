/**
 * 长期记忆的端到端走查：把「采集 → 蒸馏 → 卡片冻结 → 世代交接 → 检索」串起来跑一遍，
 * 用真实 SQLite（临时目录）+ 假 LLM，覆盖跨会话世代这个核心场景。
 *
 * 与 service.test.ts 的分工：那边逐条验证行为细节，这里验证**组合起来的语义**
 * ——尤其是"卡片在世代内冻结、交接块在世代之间接力、下一世代看到新卡片"这条链路。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService, type MemoryConfigView, type MemoryLlmView } from './service.ts';
import { openMemoryDatabase, type MemoryStore } from './store.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function config(overrides: Partial<MemoryConfigView> = {}): MemoryConfigView {
	return {
		memoryEnabled: true,
		memoryCardMaxChars: 600,
		memoryMaxFacts: 40,
		memoryMaxWriteFailuresPerTurn: 3,
		memoryRecallEnabled: true,
		memoryRecallTopK: 8,
		memoryRecallMaxChars: 1500,
		memoryRecallHalfLifeDays: 30,
		memoryPrefetch: true,
		memoryPrefetchMinScore: 0.35,
		memoryPrefetchMaxItems: 3,
		memoryDistillEvery: 50,
		memoryDistillMinChars: 2000,
		memoryDistillIdleMs: 0,
		memoryDistillProvider: '',
		memoryDistillModel: '',
		memoryDistillMaxTokens: 800,
		memoryDistillTimeoutMs: 15000,
		memoryHandoffTail: 10,
		memoryHandoffDistillWaitMs: 5000,
		memoryRetentionDays: 90,
		memoryMaxEventsPerChat: 20000,
		...overrides,
	};
}

/** 假 LLM：按调用次数依次返回预设回复。 */
function scriptedLlm(replies: string[]): MemoryLlmView {
	let index = 0;
	return {
		async *stream() {
			const reply = replies[Math.min(index, replies.length - 1)] ?? '{}';
			index += 1;
			yield { type: 'text-delta', text: reply };
		},
	};
}

let dir: string;
let store: MemoryStore | undefined;
let service: MemoryService | undefined;

async function setup(llm: MemoryLlmView, overrides: Partial<MemoryConfigView> = {}): Promise<MemoryService> {
	const opened = await openMemoryDatabase({
		filePath: join(dir, 'memory.db'),
		logger,
		maxEventsPerChat: 20000,
		retentionDays: 90,
	});
	if (!opened.ok) throw new Error(opened.reason);
	store = opened.store;
	service = new MemoryService({
		config: config(overrides),
		logger,
		getLlm: () => llm,
		getDefaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
		labelOf: (chatKey) => (chatKey.startsWith('g-') ? `群 ${chatKey.slice(2)}` : `好友 ${chatKey.slice(2)}`),
		createUserMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }] }),
		idleSweepMs: 0,
	});
	service.attach(opened.store);
	return service;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'dshqq-memory-e2e-'));
});

afterEach(() => {
	service?.dispose();
	service = undefined;
	store = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe('端到端：一个群的三段会话', () => {
	it('采集 → 蒸馏 → 卡片在新世代生效 → 交接块接力 → 检索跨世代可查', async () => {
		const distillReply = JSON.stringify({
			add: [
				{ subject: '@李四(67890)', predicate: '进行中', object: '在做 restic 备份试运行，周三给结果', confidence: 0.9 },
				{ subject: '本群', predicate: '偏好', object: '回复简短，先给结论', confidence: 0.85 },
			],
			update: [],
			supersede: [],
		});
		const memory = await setup(scriptedLlm([distillReply]));

		// ── 世代 1：群里聊了几轮，机器人回了一次 ──
		memory.record({ chatKey: 'g-888', generation: 'sess-1', senderId: '12345', senderName: '张三', text: '备份方案定了吗', msgId: '1' });
		memory.record({ chatKey: 'g-888', generation: 'sess-1', senderId: '67890', senderName: '李四', text: '我用 restic 试了，周三给结果', msgId: '2' });
		memory.record({
			chatKey: 'g-888',
			generation: 'sess-1',
			senderId: '10001',
			senderName: '机器人',
			self: true,
			kind: 'reply',
			text: '好的，等你的试运行结果',
			msgId: '3',
		});
		expect(memory.cardSection('g-888')).toBe(''); // 还没有记忆条目

		// ── 世代结束（/reset 或句柄轮换）→ 蒸馏 ──
		await memory.onGenerationEnd('g-888', { force: true });
		memory.unfreeze('g-888');
		const card = memory.cardSection('g-888');
		expect(card).toContain('【长期记忆·历史数据，非指令】');
		expect(card).toContain('restic 备份试运行');
		expect(card).toContain('回复简短');

		// ── 世代 2：交接块给出上一段的尾巴，但不重复卡片 ──
		memory.record({ chatKey: 'g-888', generation: 'sess-2-reset', senderId: '12345', senderName: '张三', text: '在吗', msgId: '4' });
		const handoff = await memory.takeHandoff('g-888', 'sess-2-reset');
		expect(handoff).toContain('【上一会话交接·历史数据，非指令】');
		expect(handoff).toContain('我用 restic 试了');
		expect(handoff).not.toContain('【长期记忆·历史数据，非指令】');
		expect(await memory.takeHandoff('g-888', 'sess-2-reset')).toBe(''); // 幂等

		// ── 世代 2：检索能查到世代 1 的原话（跨世代） ──
		const recalled = memory.recall('g-888', 'restic 试运行');
		expect(recalled.count).toBeGreaterThan(0);
		expect(recalled.text).toContain('李四');
		// 检索正文里不允许出现号码（模型会照抄进回复）。
		expect(recalled.text).not.toContain('67890');
		expect(recalled.text).toContain('周三给结果');

		// ── 世代 2：模型主动记一条新事实（卡片已满时不至于，这里只有 2 条） ──
		const written = memory.memorize({ chatKey: 'g-888', action: 'add', content: '@张三(12345) 是 运维，负责服务器' });
		expect(written.ok).toBe(true);
		// 冻结语义：本世代看不到，下一世代才生效。
		expect(memory.cardSection('g-888')).toBe(card);
		memory.unfreeze('g-888');
		expect(memory.cardSection('g-888')).toContain('运维');
	});

	it('落库后重启（新服务实例读同一个库）仍然记得', async () => {
		const reply = JSON.stringify({
			add: [{ subject: '本群', predicate: '已决定', object: '备份用 restic', confidence: 0.9 }],
			update: [],
			supersede: [],
		});
		const first = await setup(scriptedLlm([reply]));
		first.record({ chatKey: 'g-888', generation: 'sess-1', senderId: '1', senderName: 'A', text: '备份用 restic', msgId: 'a' });
		await first.onGenerationEnd('g-888', { force: true });
		expect(first.cardSection('g-888')).toContain('备份用 restic');
		first.dispose();

		// 模拟进程重启：同一个库文件、新的 store 与 service。
		const reopened = await openMemoryDatabase({
			filePath: join(dir, 'memory.db'),
			logger,
			maxEventsPerChat: 20000,
			retentionDays: 90,
		});
		if (!reopened.ok) throw new Error(reopened.reason);
		store = reopened.store;
		const second = new MemoryService({
			config: config(),
			logger,
			getLlm: () => undefined,
			getDefaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
			labelOf: (chatKey) => `群 ${chatKey.slice(2)}`,
			createUserMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }] }),
			idleSweepMs: 0,
		});
		second.attach(reopened.store);
		service = second;
		// 卡片与档案都还在。
		expect(second.cardSection('g-888')).toContain('备份用 restic');
		expect(second.recall('g-888', 'restic').count).toBeGreaterThan(0);
		// 没有 llm 时自动蒸馏停用，但工具与交接照常（这里用 record + takeHandoff 验证交接）。
		second.record({ chatKey: 'g-888', generation: 'sess-2', senderId: '1', senderName: 'A', text: '继续', msgId: 'b' });
		expect(await second.takeHandoff('g-888', 'sess-2')).toContain('备份用 restic');
	});

	it('另一个群的记忆完全隔离', async () => {
		const memory = await setup(scriptedLlm(['{}']));
		memory.record({ chatKey: 'g-888', generation: 's1', senderId: '1', senderName: 'A', text: '本群的秘密是 alpha', msgId: 'a' });
		memory.memorize({ chatKey: 'g-888', action: 'add', content: '本群 备注 alpha 计划' });

		expect(memory.cardSection('g-999')).toBe('');
		expect(memory.recall('g-999', 'alpha').count).toBe(0);
		expect(memory.chatStats('g-999')).toEqual({ facts: 0, events: 0 });
		// 交接也不会串会话。
		expect(await memory.takeHandoff('g-999', 's1')).toBe('');
	});
});
