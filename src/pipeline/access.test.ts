import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DshQQConfig } from '../config.ts';
import { AccessControl, AdminStore, MsgDeduper, RateLimiter } from './access.ts';
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

describe('AccessControl', () => {
	it('allowlist 模式空列表 = 全部拒绝（安全默认）', () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'dshqq-'));
		const admins = new AdminStore(baseConfig(), dataDir, logger);
		const access = new AccessControl(baseConfig(), admins);
		expect(access.checkPrivate('12345')).toBe(false);
		expect(access.checkGroup('888', '12345')).toBe(false);
	});

	it('allowlist 命中放行，黑名单始终拒绝', () => {
		const config = baseConfig({ allowedUsers: ['111'], allowedGroups: ['888'], blockedUsers: ['222'] });
		const dataDir = mkdtempSync(join(tmpdir(), 'dshqq-'));
		const access = new AccessControl(config, new AdminStore(config, dataDir, logger));
		expect(access.checkPrivate('111')).toBe(true);
		expect(access.checkPrivate('333')).toBe(false);
		expect(access.checkGroup('888', '333')).toBe(true);
		expect(access.checkPrivate('222')).toBe(false);
		expect(access.checkGroup('888', '222')).toBe(false);
	});

	it('open / disabled 模式', () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'dshqq-'));
		const openConfig = baseConfig({ privateMode: 'open', groupMode: 'open' });
		const open = new AccessControl(openConfig, new AdminStore(openConfig, dataDir, logger));
		expect(open.checkPrivate('anyone')).toBe(true);
		const disabledConfig = baseConfig({ privateMode: 'disabled' });
		const disabled = new AccessControl(disabledConfig, new AdminStore(disabledConfig, dataDir, logger));
		expect(disabled.checkPrivate('anyone')).toBe(false);
	});

	it('管理员绕过白名单；禁用模式下管理员也不例外', () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'dshqq-'));
		const config = baseConfig({ adminUsers: ['9000'] });
		const access = new AccessControl(config, new AdminStore(config, dataDir, logger));
		expect(access.checkPrivate('9000')).toBe(true);
		const disabledConfig = baseConfig({ adminUsers: ['9000'], privateMode: 'disabled' });
		const disabled = new AccessControl(disabledConfig, new AdminStore(disabledConfig, dataDir, logger));
		expect(disabled.checkPrivate('9000')).toBe(false);
	});
});

describe('AdminStore', () => {
	it('持久化加载与增删', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'dshqq-'));
		writeFileSync(join(dataDir, 'admins.json'), JSON.stringify(['777']), 'utf8');
		const config = baseConfig({ adminUsers: ['888'] });
		const store = new AdminStore(config, dataDir, logger);
		await store.load();
		expect(store.list()).toEqual(['888', '777']);
		expect(await store.add('999')).toBe(true);
		expect(await store.add('888')).toBe(false); // 配置里的不去重文件
		expect(store.isAdmin('999')).toBe(true);
		expect(await store.remove('777')).toBe(true);
		expect(store.isAdmin('777')).toBe(false);
	});
});

describe('RateLimiter', () => {
	it('窗口内限速', () => {
		const limiter = new RateLimiter(1000, 2);
		expect(limiter.consume('k', 0)).toBe(true);
		expect(limiter.consume('k', 1)).toBe(true);
		expect(limiter.consume('k', 2)).toBe(false);
		expect(limiter.consume('k', 1001)).toBe(true);
	});

	it('max=0 禁用', () => {
		const limiter = new RateLimiter(1000, 0);
		for (let i = 0; i < 100; i++) expect(limiter.consume('k', 0)).toBe(true);
	});

	it('按 key 隔离', () => {
		const limiter = new RateLimiter(1000, 1);
		expect(limiter.consume('a', 0)).toBe(true);
		expect(limiter.consume('b', 0)).toBe(true);
		expect(limiter.consume('a', 1)).toBe(false);
	});
});

describe('MsgDeduper', () => {
	it('同 id 只放行一次', () => {
		const deduper = new MsgDeduper();
		expect(deduper.checkAndMark('1')).toBe(true);
		expect(deduper.checkAndMark('1')).toBe(false);
		expect(deduper.checkAndMark('2')).toBe(true);
	});

	it('容量淘汰最旧', () => {
		const deduper = new MsgDeduper(2);
		deduper.checkAndMark('1');
		deduper.checkAndMark('2');
		deduper.checkAndMark('3');
		expect(deduper.checkAndMark('1')).toBe(true); // 已被淘汰
		expect(deduper.checkAndMark('3')).toBe(false);
	});

	it('无 id 放行', () => {
		expect(new MsgDeduper().checkAndMark(undefined)).toBe(true);
	});
});
