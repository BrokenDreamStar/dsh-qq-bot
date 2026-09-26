import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DshQQConfig } from '../config.ts';
import { RosterService } from './roster.ts';
import type { GroupMemberListInfo, GroupMemberInfo } from './api.ts';
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
		privateMode: 'allowlist',
		groupMode: 'allowlist',
		allowedUsers: [],
		allowedGroups: [],
		blockedUsers: [],
		blockedGroups: [],
		adminUsers: [],
		adminUsersFile: '',
		groupMentionOnly: true,
		wakePrefixes: [],
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

interface FakeApi {
	listCalls: number;
	infoCalls: number;
	list?: GroupMemberListInfo[];
	info?: GroupMemberInfo;
	getGroupMemberList(groupId: string): Promise<GroupMemberListInfo[] | undefined>;
	getGroupMemberInfo(groupId: string, userId: string): Promise<GroupMemberInfo | undefined>;
}

function fakeApi(members: GroupMemberListInfo[] = []): FakeApi {
	return {
		listCalls: 0,
		infoCalls: 0,
		list: members,
		getGroupMemberList: async function () {
			this.listCalls += 1;
			return this.list;
		},
		getGroupMemberInfo: async function (_groupId: string, userId: string) {
			this.infoCalls += 1;
			if (this.info !== undefined) return { ...this.info, user_id: userId };
			return undefined;
		},
	};
}

function makeRoster(api: FakeApi, configOverrides: Partial<DshQQConfig> = {}, selfId = '10000'): RosterService {
	return new RosterService({
		api,
		config: baseConfig(configOverrides),
		logger,
		dataDir: mkdtempSync(join(tmpdir(), 'dshqq-roster-')),
		getSelfId: () => selfId,
	});
}

const MEMBERS: GroupMemberListInfo[] = [
	{ user_id: '10000', nickname: 'Bot', card: '青鸟', role: 'member' },
	{ user_id: '11111', nickname: '张三', card: '', role: 'owner' },
	{ user_id: '22222', nickname: '李四', card: '李总', role: 'admin' },
	{ user_id: '33333', nickname: '王五', card: '', role: 'member' },
	{ user_id: '44444', nickname: '张三', card: '', role: 'member' },
];

describe('RosterService.sectionFor', () => {
	it('列出成员并标注群主/管理员/自己（只给昵称，不含号码）', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api);
		roster.touchGroup('888', '33333');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const section = roster.sectionFor('888');
		expect(section).toContain('青鸟（是你自己）');
		expect(section).toContain('张三（群主）');
		expect(section).toContain('李总（管理员）');
		expect(section).toContain('王五');
		expect(section).toContain('共 5 人');
		// 号码一律不进模型可见文本：出现即回归（用户明确要求不输出 QQ 号）。
		expect(section).not.toMatch(/\d{5,11}/);
	});

	it('纪律提示明确禁止写出号码', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api);
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const section = roster.sectionFor('888');
		expect(section).toContain('不要在回复里写出任何人的 QQ 号');
	});

	it('重名成员各自列出（不再靠号码区分）', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api);
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const section = roster.sectionFor('888');
		expect(section).toContain('张三（群主）');
		expect(section.match(/张三/g)?.length).toBe(2);
	});

	it('超过上限时截断并注明', async () => {
		const many: GroupMemberListInfo[] = Array.from({ length: 30 }, (_, i) => ({
			user_id: String(1000 + i),
			nickname: `成员${i}`,
			card: '',
			role: 'member',
		}));
		const api = fakeApi(many);
		const roster = makeRoster(api, { rosterMaxMembers: 10 });
		roster.touchGroup('888', '1000');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const section = roster.sectionFor('888');
		expect(section).toContain('共 30 人');
		expect(section).toContain('其余 20 人未列出');
	});

	it('未启用或无缓存时返回空', async () => {
		const roster = makeRoster(fakeApi(MEMBERS), { rosterEnabled: false });
		expect(roster.sectionFor('888')).toBe('');
		const empty = makeRoster(fakeApi([]));
		expect(empty.sectionFor('888')).toBe('');
	});
});

describe('RosterService.renderMentions', () => {
	it('把 @号码 重写为 @昵称（不保留号码）', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api);
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const out = await roster.renderMentions('你觉得 @22222 和 @33333 谁对？', '888');
		expect(out).toBe('你觉得 @李总 和 @王五 谁对？');
	});

	it('未知号码走 get_group_member_info 回填，同样不带号码', async () => {
		const api = fakeApi(MEMBERS);
		api.info = { user_id: '99999', nickname: '赵六', card: '' };
		const roster = makeRoster(api);
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const out = await roster.renderMentions('问下 @99999', '888');
		expect(out).toBe('问下 @赵六');
		expect(api.infoCalls).toBe(1);
	});

	it('查不到名字时保留原样', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api);
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		const out = await roster.renderMentions('问下 @98765', '888');
		expect(out).toBe('问下 @98765');
	});

	it('无 @ 或私聊（groupId undefined）原样返回', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api);
		expect(await roster.renderMentions('普通消息', '888')).toBe('普通消息');
		expect(await roster.renderMentions('@11111 在吗', undefined)).toBe('@11111 在吗');
	});
});

describe('RosterService TTL', () => {
	it('TTL 内只拉一次全量列表', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api, { rosterTtlMs: 60 });
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		roster.touchGroup('888', '22222');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(api.listCalls).toBe(1);
	}, 5000);

	it('TTL 过期后重新拉取', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api, { rosterTtlMs: 30 });
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(api.listCalls).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 40));
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(api.listCalls).toBe(2);
	}, 5000);

	it('未启用时不拉取', async () => {
		const api = fakeApi(MEMBERS);
		const roster = makeRoster(api, { rosterEnabled: false });
		roster.touchGroup('888', '11111');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(api.listCalls).toBe(0);
	});
});
