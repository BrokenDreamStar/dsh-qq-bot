import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatBridge, ChatBridgeManager, defaultAgentCwd, groupDirNameFor, isSameDir, mediaDirFor, sessionDirFor } from './chat.ts';
import { ChatSessionStore, legacySessionMarkerPath } from './sessionStore.ts';
import type { DshQQConfig } from '../config.ts';
import type { DshServices } from '../dsh.ts';
import type { PersonaStore } from '../persona/store.ts';
import type { AgentOptions } from '../dsh.ts';
import type { InboundMessage } from '../onebot/events.ts';
import type { OBSegment } from '../onebot/segments.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** 只关心模型选择的最小桥：其余依赖用空壳占位。 */
function makeBridge(input: {
	scope?: 'group' | 'private';
	chatId?: string;
	override?: string;
	/** 「默认会话」行配置的模型（WebUI 第一行）。 */
	configDefault?: string;
	defaultModel?: AgentOptions;
	agents?: unknown;
	/** 会话目录（默认临时目录）；给定时同时决定 groupName 与默认 agentCwd。 */
	sessionDir?: string;
	groupName?: string;
	/** 显式 agent 工作目录（模拟 /cwd 覆盖或网关模式；缺省 = 会话目录）。 */
	agentCwd?: string;
	workspaces?: () => unknown;
	/** 预置身份表（默认空表）。 */
	sessions?: ChatSessionStore;
	/** 预置旧版工作目录标记内容（迁移用）。 */
	legacyMarker?: string;
	/** 同一条提示是否允许发送（缺省 = 允许）。 */
	claimNotice?: (noticeId: string) => boolean;
	/** 追加/覆盖配置项（提问中继等只在特定配置下工作的路径用）。 */
	config?: Partial<DshQQConfig>;
	/** 替换 api（默认空壳；发消息的路径要能记下调用）。 */
	api?: unknown;
}): ChatBridge {
	const scope = input.scope ?? 'group';
	const chatId = input.chatId ?? '123456';
	const config = { groupSession: 'shared', ...input.config } as unknown as DshQQConfig;
	const services = {
		agentDefaultModel: { currentSelection: () => input.defaultModel ?? { provider: 'dsh', model: 'base' } },
		agents: input.agents ?? {},
	} as unknown as DshServices;
	const store = {
		getChatModel: () => input.override,
		defaultModel: () => input.configDefault,
		resolve: () => ({ name: 'default', prompt: '' }),
	} as unknown as PersonaStore;
	const sessionDir = input.sessionDir ?? mkdtempSync(join(tmpdir(), 'dshqq-model-'));
	const key = scope === 'private' ? `u-${chatId}` : `g-${chatId}`;
	const groupName = input.groupName ?? `${scope === 'private' ? 'Friend' : 'Group'}_${chatId}`;
	if (input.legacyMarker !== undefined) writeFileSync(legacySessionMarkerPath(sessionDir), input.legacyMarker, 'utf8');
	return new ChatBridge({
		key,
		scope,
		chatId,
		senderId: '1',
		senderName: 'tester',
		sessionDir,
		agentCwd: input.agentCwd ?? sessionDir,
		groupName,
		mediaDir: mediaDirFor(sessionDir, key),
		api: (input.api ?? {}) as never,
		config,
		services,
		store,
		roster: {} as never,
		admins: {} as never,
		logger,
		getWorkspaces: input.workspaces as never,
		sessions: input.sessions ?? ChatSessionStore.load(mkdtempSync(join(tmpdir(), 'dshqq-sessions-'))),
		claimNotice: input.claimNotice,
		getSelfId: () => '',
	});
}

describe('会话目录（sessionDirFor / groupDirNameFor / mediaDirFor）', () => {
	it('私聊用 Friend_<QQ号>，群聊用 Group_<群号>', () => {
		expect(groupDirNameFor('private', '12345')).toBe('Friend_12345');
		expect(groupDirNameFor('group', '23456')).toBe('Group_23456');
	});

	it('会话目录恒为根下的固定子目录（不再有"不分组"分支）', () => {
		expect(sessionDirFor('/data/qq-groups', 'private', '12345')).toBe(join('/data/qq-groups', 'Friend_12345'));
		expect(sessionDirFor('/data/qq-groups', 'group', '23456')).toBe(join('/data/qq-groups', 'Group_23456'));
	});

	it('媒体目录按 chatKey 分：同群不同用户不混图（会话隔离不靠目录）', () => {
		expect(mediaDirFor('/d/Group_23456', 'g-23456')).toBe(join('/d/Group_23456', 'media', 'g-23456'));
		expect(mediaDirFor('/d/Group_23456', 'g-23456-u-7')).toBe(join('/d/Group_23456', 'media', 'g-23456-u-7'));
	});
});

describe('defaultAgentCwd（无 /cwd 覆盖时的默认工作目录）', () => {
	it('默认用会话目录', () => {
		expect(defaultAgentCwd({ workspaceMode: 'chat', homeDir: '/home/u', sessionDir: '/d/Friend_1' })).toBe('/d/Friend_1');
	});

	it('网关模式用主目录', () => {
		expect(defaultAgentCwd({ workspaceMode: 'home', homeDir: '/home/u', sessionDir: '/d/Friend_1' })).toBe('/home/u');
	});
});

describe('ChatBridge.modelInfo（会话/WebUI 模型配置接线）', () => {
	it('未配置时用部署默认', () => {
		const info = makeBridge({}).modelInfo();
		expect(info.spec).toBe('dsh/base');
		expect(info.source).toEqual({ kind: 'default' });
	});

	it('命中会话配置', () => {
		const info = makeBridge({ override: 'route/model' }).modelInfo();
		expect(info.spec).toBe('route/model');
		expect(info.source).toEqual({ kind: 'chatOverride' });
	});

	it('只写模型名时用部署默认 provider 补齐', () => {
		const info = makeBridge({ override: 'small-model', scope: 'private', chatId: '9' }).modelInfo();
		expect(info.spec).toBe('dsh/small-model');
	});

	it('非法配置视为未配置', () => {
		const info = makeBridge({ override: 'broken/' }).modelInfo();
		expect(info.spec).toBe('dsh/base');
		expect(info.source).toEqual({ kind: 'default' });
	});
});

describe('写句柄冲突恢复（ensureAgent）', () => {
	const ownedError = () => new Error('session "qq-group-123456" is already owned by an active write handle');

	it('短暂冲突：退避重试后恢复，不换会话', async () => {
		vi.useFakeTimers();
		try {
			const handle = { agent: { id: 'a' }, dispose: async () => {} };
			const resume = vi.fn().mockRejectedValueOnce(ownedError()).mockResolvedValue(handle);
			const create = vi.fn();
			const bridge = makeBridge({ agents: { resume, create, get: () => undefined } });
			const before = bridge.sessionIdString;
			const pending = bridge.ensureAgent();
			await vi.advanceTimersByTimeAsync(5000);
			await pending;
			expect(resume).toHaveBeenCalledTimes(2);
			expect(create).not.toHaveBeenCalled();
			expect(bridge.sessionIdString).toBe(before);
		} finally {
			vi.useRealTimers();
		}
	});

	it('持续被占用：自动开启新会话', async () => {
		vi.useFakeTimers();
		try {
			const handle = { agent: { id: 'b' }, dispose: async () => {} };
			const resume = vi.fn().mockRejectedValue(ownedError());
			const create = vi.fn().mockResolvedValue(handle);
			const bridge = makeBridge({ agents: { resume, create, get: () => ({ id: 'live' }) } });
			const before = bridge.sessionIdString;
			const pending = bridge.ensureAgent();
			await vi.advanceTimersByTimeAsync(10000);
			const agent = await pending;
			expect(agent).toBe(handle.agent);
			expect(resume).toHaveBeenCalledTimes(4);
			expect(create).toHaveBeenCalledTimes(1);
			expect(bridge.sessionIdString).toMatch(/-reset-\d+$/);
			expect(bridge.sessionIdString).not.toBe(before);
		} finally {
			vi.useRealTimers();
		}
	});

	it('持久会话不存在：直接新建，不重试', async () => {
		const handle = { agent: { id: 'c' }, dispose: async () => {} };
		const resume = vi.fn().mockRejectedValue(new Error('session "qq-group-123456" not found'));
		const create = vi.fn().mockResolvedValue(handle);
		const bridge = makeBridge({ agents: { resume, create, get: () => undefined } });
		await bridge.ensureAgent();
		expect(resume).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledTimes(1);
		expect(bridge.sessionIdString).toBe('qq-group-123456');
	});

	it('其它错误原样抛出（不回退 create）', async () => {
		const resume = vi.fn().mockRejectedValue(new Error('boom'));
		const create = vi.fn();
		const bridge = makeBridge({ agents: { resume, create, get: () => undefined } });
		await expect(bridge.ensureAgent()).rejects.toThrow('boom');
		expect(create).not.toHaveBeenCalled();
	});
});

describe('会话分组挂载（attachToGroup）', () => {
	it('分组开启时注册工作区并把会话挂进去', async () => {
		const created: Array<{ path: string; title: string | undefined }> = [];
		const attached: string[] = [];
		const registry = {
			create: async (path: string, title?: string) => {
				created.push({ path, title });
				return {
					path,
					title: title ?? '',
					attachSession: async (id: unknown) => {
						attached.push(String(id));
					},
				};
			},
		};
		const handle = { agent: { id: 'x' }, dispose: async () => {} };
		const bridge = makeBridge({
			sessionDir: '/data/qq-groups/Friend_123456',
			groupName: 'Friend_123456',
			agents: { resume: vi.fn().mockResolvedValue(handle), create: vi.fn(), get: () => undefined },
			workspaces: () => registry,
		});
		await bridge.ensureAgent();
		expect(created).toEqual([{ path: '/data/qq-groups/Friend_123456', title: 'Friend_123456' }]);
		expect(attached).toEqual(['qq-group-123456']);
		// 目录一致：不该给用户发任何提示。
		expect(bridge.takeSessionNotice()).toBeUndefined();
	});

	it('工作区服务不可用时不报错（仅跳过分组）', async () => {
		const handle = { agent: { id: 'y' }, dispose: async () => {} };
		const bridge = makeBridge({
			sessionDir: '/data/qq-groups/Friend_123456',
			groupName: 'Friend_123456',
			agents: { resume: vi.fn().mockResolvedValue(handle), create: vi.fn(), get: () => undefined },
			workspaces: () => undefined,
		});
		await expect(bridge.ensureAgent()).resolves.toBe(handle.agent);
	});

	it('会话 cwd 与分组目录不一致：不自动换会话、不挂载，只提示 /reset', async () => {
		const created: string[] = [];
		const attached: string[] = [];
		const registry = {
			create: async (path: string) => {
				created.push(path);
				return { path, title: '', attachSession: async (id: unknown) => void attached.push(String(id)) };
			},
		};
		// 真实场景：旧会话 header.cwd 停在隔离工作区（目录被清理过 / 分组是后配的），
		// dsh 的 resume 会保留它，attachSession 必然被拒。
		const handle = { agent: { id: 'x', session: { header: { cwd: '/Users/someone/qq-chats/u-123456' } } }, dispose: async () => {} };
		const bridge = makeBridge({
			sessionDir: '/data/qq-groups/Friend_123456',
			groupName: 'Friend_123456',
			agents: { resume: vi.fn().mockResolvedValue(handle), create: vi.fn(), get: () => undefined },
			workspaces: () => registry,
		});
		const before = bridge.sessionIdString;
		await bridge.ensureAgent();
		expect(bridge.sessionIdString).toBe(before);
		expect(created).toEqual([]);
		expect(attached).toEqual([]);
		const notice = bridge.takeSessionNotice();
		expect(notice).toContain('/reset');
		expect(notice).toContain('Friend_123456');
		// 取出即清空，不重复刷屏。
		expect(bridge.takeSessionNotice()).toBeUndefined();
	});

	it('已提示过的 cwd 提示不再重复发送（claimNotice 拒绝）', async () => {
		const handle = { agent: { id: 'x', session: { header: { cwd: '/old/dir' } } }, dispose: async () => {} };
		const bridge = makeBridge({
			sessionDir: '/data/qq-groups/Friend_123456',
			groupName: 'Friend_123456',
			agents: { resume: vi.fn().mockResolvedValue(handle), create: vi.fn(), get: () => undefined },
			claimNotice: () => false,
		});
		await bridge.ensureAgent();
		expect(bridge.takeSessionNotice()).toBeUndefined();
	});
});

describe('会话身份（sessionStore 接线）', () => {
	it('始终使用身份表里的上次会话，不退回基础 id', () => {
		const sessions = ChatSessionStore.load(mkdtempSync(join(tmpdir(), 'dshqq-sessions-')));
		sessions.set('g-123456', 'qq-group-123456-reset-1788929089333');
		expect(makeBridge({ sessions }).sessionIdString).toBe('qq-group-123456-reset-1788929089333');
	});

	it('无记录时用基础 id 并立刻写入身份表', () => {
		const sessions = ChatSessionStore.load(mkdtempSync(join(tmpdir(), 'dshqq-sessions-')));
		expect(makeBridge({ sessions }).sessionIdString).toBe('qq-group-123456');
		expect(sessions.get('g-123456')).toBe('qq-group-123456');
	});

	it('迁移旧版工作目录标记（工作目录被清理后则回退基础 id）', () => {
		expect(makeBridge({ legacyMarker: 'qq-group-123456-reset-9' }).sessionIdString).toBe('qq-group-123456-reset-9');
		expect(makeBridge({}).sessionIdString).toBe('qq-group-123456');
	});

	it('reset 后身份表跟着更新', async () => {
		const sessions = ChatSessionStore.load(mkdtempSync(join(tmpdir(), 'dshqq-sessions-')));
		const bridge = makeBridge({ sessions });
		await bridge.reset();
		expect(sessions.get('g-123456')).toBe(bridge.sessionIdString);
		expect(bridge.sessionIdString).toMatch(/-reset-\d+$/);
	});
});

describe('isSameDir', () => {
	it('字符串不同但指向同一目录（符号链接）时视为一致', () => {
		const real = mkdtempSync(join(tmpdir(), 'dshqq-real-'));
		const link = join(mkdtempSync(join(tmpdir(), 'dshqq-link-')), 'link');
		symlinkSync(real, link);
		expect(isSameDir(real, link)).toBe(true);
		expect(isSameDir(real, tmpdir())).toBe(false);
		// 不存在 / 无法解析的路径不能误判为一致。
		expect(isSameDir('/nope/a', '/nope/b')).toBe(false);
	});
});

describe('提问中继（user-questions 缝的 QQ 侧应答器）', () => {
	const question = {
		id: 'topic',
		question: '想了解哪方面？',
		options: [{ label: '解释' }, { label: '故事' }],
	};
	const askConfig: Partial<DshQQConfig> = {
		askUserEnabled: true,
		askUserWaitMs: 300_000,
		maxTurnMs: 600_000,
		replyMaxChars: 4500,
	};
	/** 记下发出去的 QQ 消息的假 api。 */
	function makeApi(): { api: unknown; sent: OBSegment[][]; nextId: () => number } {
		const sent: OBSegment[][] = [];
		let id = 500;
		return {
			sent,
			nextId: () => ++id,
			api: {
				sendSegments: async (_target: unknown, segments: OBSegment[]) => {
					sent.push(segments);
					return ++id;
				},
			},
		};
	}
	const userMessage = (text: string): InboundMessage =>
		({ senderId: '1001', senderName: '张三', plainText: text, text } as InboundMessage);

	it('关闭开关：不下发到 QQ，直接交给下游', async () => {
		const { api, sent } = makeApi();
		const bridge = makeBridge({ config: { ...askConfig, askUserEnabled: false }, api });
		const answer = await bridge.askFromQQ({ questions: [question] }, async () => '下游的答案');
		expect(answer).toBe('下游的答案');
		expect(sent).toHaveLength(0);
	});

	it('QQ 先答：返回 QQ 的答案（下游一直不答也不影响）', async () => {
		const { api, sent } = makeApi();
		const bridge = makeBridge({ config: askConfig, api });
		// 群聊里提问是回某个人的话：提问触发者本人的回复才算答案（见 ask.ts 的 acceptAsAnswer）。
		bridge.turnSenderId = '1001';
		const pending = bridge.askFromQQ({ questions: [question] }, () => new Promise(() => {}));
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(bridge.hasPendingQuestion()).toBe(true);
		// 群友的闲聊不算答案，也不会被吞掉（原样落回普通管线）。
		expect(bridge.acceptAnswer('2', { ...userMessage('2'), senderId: '2002' } as InboundMessage, false)).toBe(false);
		expect(bridge.acceptAnswer('2', userMessage('2'), false)).toBe(true);
		expect(await pending).toEqual({ answers: [{ id: 'topic', selected: ['故事'] }] });
		expect(bridge.hasPendingQuestion()).toBe(false);
	});

	it('下游先答（用户在 dsh 界面里点了）：用它的答案，QQ 侧不再等', async () => {
		const { api, sent } = makeApi();
		const bridge = makeBridge({ config: askConfig, api });
		const answer = await bridge.askFromQQ({ questions: [question] }, async () => '界面里的答案');
		expect(answer).toBe('界面里的答案');
		expect(sent).toHaveLength(1);
		// QQ 侧等待已撤：用户再回也不算答案了（题面里那条消息不会一直被消费）。
		expect(bridge.acceptAnswer('2', userMessage('2'), false)).toBe(false);
	});

	it('下游没有应答器（NO_PROVIDER）且 QQ 超时：抛可读的超时错误', async () => {
		vi.useFakeTimers();
		try {
			const { api } = makeApi();
			const bridge = makeBridge({ config: askConfig, api });
			const next = async () => {
				throw Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' });
			};
			const pending = bridge.askFromQQ({ questions: [question] }, next);
			const guarded = expect(pending).rejects.toThrow('等待用户回答超时');
			await vi.advanceTimersByTimeAsync(300_000);
			await guarded;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('启动预热与重建后重占（ChatBridgeManager）', () => {
	/** 最小假 handle：这条路径只用到 agent.cancel 与 dispose。 */
	const fakeHandle = () => ({ agent: { cancel: () => {} }, dispose: async () => {} });
	const ownedError = () => new Error('session "qq-private-10001-reset-9" is already owned by an active write handle');

	/** 只关心 resume/create 的 manager（其余依赖照 makeBridge 的假件给）。 */
	function makeManager(input: { dataDir: string; resume: unknown; create?: unknown }): ChatBridgeManager {
		const services = {
			agentDefaultModel: { currentSelection: () => ({ provider: 'dsh', model: 'base' }) },
			agents: {
				resume: input.resume,
				create: input.create ?? (async () => { throw new Error('create 不应被调用'); }),
				get: () => undefined,
			},
		} as unknown as DshServices;
		const store = {
			getChatModel: () => undefined,
			defaultModel: () => undefined,
			resolve: () => ({ name: 'default', prompt: '' }),
		} as unknown as PersonaStore;
		const config = { dataDir: input.dataDir, groupSession: 'shared', workspaceMode: 'chat' } as unknown as DshQQConfig;
		return new ChatBridgeManager(config, {
			api: {} as never,
			services,
			store,
			roster: {} as never,
			admins: {} as never,
			logger,
			dataDir: input.dataDir,
			getSelfId: () => '',
		});
	}

	/** 预置了身份表的临时数据目录。 */
	function dataDirWith(entries: Record<string, string>): string {
		const dataDir = mkdtempSync(join(tmpdir(), 'dshqq-warm-'));
		writeFileSync(join(dataDir, 'chat-sessions.json'), JSON.stringify(entries), 'utf8');
		return dataDir;
	}

	it('预热：按身份表逐条 resume，用记录里的会话 id', async () => {
		const seen: unknown[] = [];
		const manager = makeManager({
			dataDir: dataDirWith({ 'u-10001': 'qq-private-10001-reset-9' }),
			resume: async (options: unknown) => {
				seen.push((options as { resumeSessionId?: unknown }).resumeSessionId);
				return fakeHandle();
			},
		});
		await manager.warmup();
		expect(seen).toEqual(['qq-private-10001-reset-9']);
		expect(manager.getByChatKey('u-10001')?.sessionIdString).toBe('qq-private-10001-reset-9');
	});

	it('身份表为空：不建桥、不 resume', async () => {
		const resume = vi.fn();
		const manager = makeManager({ dataDir: dataDirWith({}), resume });
		await manager.warmup();
		expect(manager.size).toBe(0);
		expect(resume).not.toHaveBeenCalled();
	});

	it('预热撞上界面占用：不换会话、不抛错（留给下一条消息按 busyStrategy 处理）', async () => {
		vi.useFakeTimers();
		try {
			const create = vi.fn();
			const manager = makeManager({
				dataDir: dataDirWith({ 'u-10001': 'qq-private-10001-reset-9' }),
				resume: async () => { throw ownedError(); },
				create,
			});
			const pending = manager.warmup();
			await vi.advanceTimersByTimeAsync(5000);
			await expect(pending).resolves.toBeUndefined();
			expect(create).not.toHaveBeenCalled();
			expect(manager.getByChatKey('u-10001')?.sessionIdString).toBe('qq-private-10001-reset-9');
		} finally {
			vi.useRealTimers();
		}
	});

	it('重建（人格/模型保存）后立刻重新占住写句柄，不留空窗', async () => {
		const resume = vi.fn(async () => fakeHandle());
		const manager = makeManager({ dataDir: dataDirWith({ 'u-10001': 'qq-private-10001-reset-9' }), resume });
		await manager.warmup();
		expect(resume).toHaveBeenCalledTimes(1);
		await manager.rebuildAll();
		await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
	});
});
