import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDistillPayload, parseDistillOutput } from './distill.ts';
import { groupKeyOf, memberDisplayName, memberRefFor } from './member.ts';
import { MemoryService, type MemoryConfigView, type MemoryLlmView } from './service.ts';
import { openMemoryDatabase, type MemoryStore } from './store.ts';
import type { DistillInput, MemoryEvent, MemoryMember } from './types.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function config(overrides: Partial<MemoryConfigView> = {}): MemoryConfigView {
	return {
		memoryEnabled: true,
		memoryCardMaxChars: 600,
		memoryProfileMaxChars: 400,
		memoryMemberProfiles: true,
		memoryMemberProfileMaxChars: 400,
		memoryMemberAutoActive: true,
		memoryMemberMaxFacts: 60,
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
		memoryDistillRetryTokens: 16000,
		memoryDistillTimeoutMs: 15000,
		memoryHandoffTail: 10,
		memoryHandoffDistillWaitMs: 0,
		memoryRetentionDays: 90,
		memoryMaxEventsPerChat: 20000,
		...overrides,
	};
}

function member(chatKey: string, id: string, name: string): MemoryMember {
	return {
		chatKey,
		memberRef: memberRefFor(chatKey, id),
		memberId: id,
		displayName: name,
		firstSeen: 0,
		lastSeen: 0,
	};
}

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
	return {
		seq: 1,
		chatKey: 'g-888',
		generation: 'g1',
		ts: Date.now(),
		senderId: '123',
		senderName: '张三',
		self: false,
		kind: 'chat',
		text: '我用 vim，回复短一点',
		...overrides,
	};
}

function distillInput(overrides: Partial<DistillInput> = {}): DistillInput {
	return {
		chatKey: 'g-888',
		chatLabel: '群 888',
		existing: [],
		events: [event()],
		members: [member('g-888', '123', '张三'), member('g-888', '456', '李四')],
		limits: { maxNewFacts: 8, objectMaxChars: 240, contentMaxChars: 240, memberProfiles: true, memberAutoActive: true },
		...overrides,
	};
}

let dir = '';
let store: MemoryStore | undefined;
let service: MemoryService | undefined;

function fakeLlm(reply: string): MemoryLlmView {
	return {
		async *stream() {
			for (const char of reply) yield { type: 'text-delta', text: char };
		},
	};
}

async function setup(options: { config?: Partial<MemoryConfigView>; llm?: MemoryLlmView } = {}): Promise<MemoryService> {
	const opened = await openMemoryDatabase({
		filePath: join(dir, 'memory.db'),
		logger,
		maxEventsPerChat: 5000,
		retentionDays: 90,
	});
	if (!opened.ok) throw new Error(opened.reason);
	store = opened.store;
	service = new MemoryService({
		config: config(options.config),
		logger,
		getLlm: () => options.llm,
		getDefaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
		labelOf: (chatKey) => (chatKey.startsWith('g-') ? `群 ${chatKey.slice(2)}` : `好友 ${chatKey.slice(2)}`),
		createUserMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }] }),
		idleSweepMs: 0,
	});
	service.attach(opened.store);
	return service;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'dshqq-member-'));
});

afterEach(() => {
	service?.dispose();
	service = undefined;
	store = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe('成员 ref', () => {
	it('同群同人稳定；perUser 与共享群共用同一个群级 ref', () => {
		const shared = memberRefFor('g-888', '123');
		expect(memberRefFor('g-888', '123')).toBe(shared);
		expect(memberRefFor('g-888-u-123', '123')).toBe(shared);
		expect(memberRefFor('g-888', '456')).not.toBe(shared);
		expect(memberRefFor('g-999', '123')).not.toBe(shared);
		expect(shared).toMatch(/^m_[0-9a-f]{10}$/);
		expect(shared).not.toContain('123');
	});

	it('groupKeyOf 把 perUser 群会话归并到群', () => {
		expect(groupKeyOf('g-888-u-123')).toBe('g-888');
		expect(groupKeyOf('u-123')).toBe('u-123');
	});

	it('昵称为空时回退成“群友”，不回退成号码', () => {
		expect(memberDisplayName('', '群友')).toBe('群友');
		expect(memberDisplayName(undefined, '群友')).toBe('群友');
	});
});

describe('成员存储', () => {
	beforeEach(async () => {
		await setup();
	});

	it('记录成员并按昵称/QQ 号查找', () => {
		store!.upsertMember('g-888', '123', '张三');
		store!.upsertMember('g-888', '456', '李四');
		expect(store!.members('g-888').map((item) => item.displayName).sort()).toEqual(['张三', '李四'].sort());
		expect(store!.member('g-888', '123')?.displayName).toBe('张三');
		expect(store!.membersByName('g-888', '张三')).toHaveLength(1);
	});

	it('空昵称不会覆盖已知昵称', () => {
		store!.upsertMember('g-888', '123', '张三');
		store!.upsertMember('g-888', '123', '');
		expect(store!.member('g-888', '123')?.displayName).toBe('张三');
	});

	it('同一句话记在两个人名下时不去重、不互相删除', () => {
		const a = store!.addFact({
			chatKey: 'g-888',
			content: '喜欢咖啡',
			kind: 'preference',
			subjectId: '123',
			subjectName: '张三',
		});
		const b = store!.addFact({
			chatKey: 'g-888',
			content: '喜欢咖啡',
			kind: 'preference',
			subjectId: '456',
			subjectName: '李四',
		});
		expect('id' in a && 'id' in b).toBe(true);
		expect(store!.groupFacts('g-888')).toHaveLength(0);
		expect(store!.memberFacts('g-888', '123')).toHaveLength(1);
		expect(store!.memberFacts('g-888', '456')).toHaveLength(1);
		const id = ('id' in a ? a.id : 0) as number;
		expect(store!.deleteFact('g-888', id, 'user')).toBe(true);
		expect(store!.isTombstoned('g-888', '喜欢咖啡', '123')).toBe(true);
		expect(store!.isTombstoned('g-888', '喜欢咖啡', '456')).toBe(false);
		expect(store!.memberFacts('g-888', '456')).toHaveLength(1);
	});

	it('群卡片只取群级事实，成员事实单独取', () => {
		store!.addFact({ chatKey: 'g-888', content: '本群偏好简短', kind: 'rule' });
		store!.addFact({ chatKey: 'g-888', content: '张三用 vim', kind: 'profile', subjectId: '123', subjectName: '张三' });
		expect(store!.groupFacts('g-888').map((fact) => fact.content)).toEqual(['本群偏好简短']);
		expect(store!.memberFacts('g-888', '123').map((fact) => fact.content)).toEqual(['张三用 vim']);
	});
});

describe('成员蒸馏', () => {
	it('本人自述带 about/source_seq → active + owner', () => {
		const input = distillInput();
		const payload = JSON.parse(buildDistillPayload(input)) as {
			new_events: Array<Record<string, unknown>>;
		};
		expect(payload.new_events[0]?.ref).toBe(memberRefFor('g-888', '123'));
		const result = parseDistillOutput(
			JSON.stringify({
				add: [
					{
						about: memberRefFor('g-888', '123'),
						source_seq: 1,
						content: '偏好简洁回复，使用 vim',
						kind: 'preference',
						confidence: 0.9,
					},
				],
				update: [],
				supersede: [],
			}),
			input,
			1,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outcome.ops[0]).toMatchObject({
			op: 'add',
			subjectId: '123',
			subjectName: '张三',
			sourceMemberId: '123',
			sourceSeq: 1,
			provenance: 'owner',
			status: 'active',
		});
	});

	it('别人转述同一个人 → pending + untrusted', () => {
		const input = distillInput({ events: [event({ senderId: '456', senderName: '李四', text: '张三喜欢咖啡' })] });
		const result = parseDistillOutput(
			JSON.stringify({
				add: [
					{
						about: memberRefFor('g-888', '123'),
						source_seq: 1,
						content: '张三喜欢咖啡',
						kind: 'preference',
						confidence: 0.9,
					},
				],
				update: [],
				supersede: [],
			}),
			input,
			1,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outcome.ops[0]).toMatchObject({
			op: 'add',
			subjectId: '123',
			sourceMemberId: '456',
			provenance: 'untrusted',
			status: 'pending',
		});
	});

	it('无法识别的 about 直接跳过，不降级成群体事实', () => {
		const result = parseDistillOutput(
			JSON.stringify({
				add: [{ about: 'm_ffffffffff', source_seq: 1, content: '不确定是谁', kind: 'fact' }],
				update: [],
				supersede: [],
			}),
			distillInput(),
			1,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.outcome.ops).toEqual([]);
	});

	it('没有 source_seq 的成员事实进候选区', () => {
		const result = parseDistillOutput(
			JSON.stringify({
				add: [{ about: memberRefFor('g-888', '123'), content: '张三喜欢咖啡', kind: 'preference' }],
				update: [],
				supersede: [],
			}),
			distillInput(),
			1,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outcome.ops[0]).toMatchObject({ status: 'pending', provenance: 'untrusted' });
	});
});

describe('成员画像注入与服务', () => {
	beforeEach(async () => {
		await setup();
	});

	it('只注入当前成员的画像，不混进群卡片', async () => {
		const memory = service!;
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '123', senderName: '张三', text: '我用 vim' });
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '456', senderName: '李四', text: '我用 emacs' });
		memory.memorize({ chatKey: 'g-888', action: 'add', content: '偏好简洁回复', kind: 'preference', subjectId: '123', subjectName: '张三', self: true });
		memory.memorize({ chatKey: 'g-888', action: 'add', content: '偏好 emacs', kind: 'preference', subjectId: '456', subjectName: '李四', self: true });
		expect(memory.memberProfile('g-888', '123')).toContain('偏好简洁回复');
		expect(memory.memberProfile('g-888', '123')).not.toContain('emacs');
		expect(memory.memberProfile('g-888', '456')).toContain('emacs');
		expect(memory.cardSection('g-888')).not.toContain('偏好简洁回复');
		expect(memory.listMembers('g-888').map((item) => item.displayName).sort()).toEqual(['张三', '李四'].sort());
	});

	it('转述默认 pending，批准后才进画像；忘掉我删除全部条目', async () => {
		const memory = service!;
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '123', senderName: '张三', text: '你好' });
		const added = memory.memorize({
			chatKey: 'g-888',
			action: 'add',
			content: '张三喜欢咖啡',
			kind: 'preference',
			subjectId: '123',
			subjectName: '张三',
			self: false,
			isAdmin: false,
		});
		expect(added.ok).toBe(true);
		expect(memory.memberProfile('g-888', '123')).toBe('');
		const pending = memory.listItems('g-888', { subjectId: '123', status: 'pending' });
		expect(pending).toHaveLength(1);
		expect(memory.approveItem('g-888', pending[0]!.id)).toBe(true);
		expect(memory.memberProfile('g-888', '123')).toContain('喜欢咖啡');
		expect(memory.forgetMember('g-888', '123', 'user:123')).toBe(1);
		expect(memory.memberProfile('g-888', '123')).toBe('');
		expect(memory.listMembers('g-888')).toHaveLength(0);
	});

	it('蒸馏端到端：自述 active、候选审核不误伤、画像可注入', async () => {
		const ref = memberRefFor('g-888', '123');
		const reply = JSON.stringify({
			add: [
				{ about: ref, source_seq: 1, content: '偏好简洁回复', kind: 'preference', confidence: 0.9 },
			],
			update: [],
			supersede: [],
		});
		const memory = await setup({
			config: { memoryDistillEvery: 1, memoryDistillMinChars: 1, memoryCandidateReview: true },
			llm: fakeLlm(reply),
		});
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '123', senderName: '张三', text: '我用 vim，回复短一点' });
		expect(await memory.distill('g-888', { force: true })).toBe(true);
		expect(memory.memberProfile('g-888', '123')).toContain('偏好简洁回复');
		expect(memory.listItems('g-888', { subjectId: '123', status: 'pending' })).toHaveLength(0);
	});

	it('关闭 memoryMemberAutoActive 后自述也进候选区', async () => {
		const ref = memberRefFor('g-888', '123');
		const reply = JSON.stringify({
			add: [{ about: ref, source_seq: 1, content: '偏好简洁回复', kind: 'preference', confidence: 0.9 }],
			update: [],
			supersede: [],
		});
		const memory = await setup({
			config: { memoryDistillEvery: 1, memoryDistillMinChars: 1, memoryMemberAutoActive: false },
			llm: fakeLlm(reply),
		});
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '123', senderName: '张三', text: '我用 vim' });
		expect(await memory.distill('g-888', { force: true })).toBe(true);
		expect(memory.memberProfile('g-888', '123')).toBe('');
		expect(memory.listItems('g-888', { subjectId: '123', status: 'pending' })).toHaveLength(1);
	});

	it('按成员检索只返回该成员的事实与消息', async () => {
		const memory = service!;
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '123', senderName: '张三', text: '备份用 restic' });
		memory.record({ chatKey: 'g-888', generation: 'g1', senderId: '456', senderName: '李四', text: '备份用 borg' });
		memory.memorize({ chatKey: 'g-888', action: 'add', content: '偏好 restic', kind: 'preference', subjectId: '123', subjectName: '张三', self: true });
		memory.memorize({ chatKey: 'g-888', action: 'add', content: '偏好 borg', kind: 'preference', subjectId: '456', subjectName: '李四', self: true });
		const result = memory.recall('g-888', '备份', 8, '张三');
		expect(result.text).toContain('restic');
		expect(result.text).not.toContain('borg');
	});
});
