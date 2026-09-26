import { describe, expect, it } from 'vitest';
import type { DshQQConfig } from './config.ts';
import { hotApplyConfig, rateLimitSignature, transportSignature } from './configSync.ts';

function makeConfig(overrides: Partial<DshQQConfig> = {}): DshQQConfig {
	return {
		transport: 'forward',
		url: 'ws://127.0.0.1:3001',
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

describe('transportSignature', () => {
	it('连接参数不变时签名稳定', () => {
		const a = transportSignature(makeConfig());
		const b = transportSignature(makeConfig({ foldForward: false, debug: true }));
		expect(b).toBe(a);
	});

	it('任一连接参数变化都改变签名', () => {
		const base = transportSignature(makeConfig());
		expect(transportSignature(makeConfig({ transport: 'reverse' }))).not.toBe(base);
		expect(transportSignature(makeConfig({ url: 'ws://10.0.0.1:3001' }))).not.toBe(base);
		expect(transportSignature(makeConfig({ reversePort: 7000 }))).not.toBe(base);
		expect(transportSignature(makeConfig({ accessToken: 't' }))).not.toBe(base);
		expect(transportSignature(makeConfig({ reconnectDelayMs: 5000 }))).not.toBe(base);
	});
});

describe('hotApplyConfig', () => {
	it('原地合并最新配置并返回是否需要重建 transport', () => {
		const target = makeConfig();
		const resolved = makeConfig({ foldForward: false, foldThreshold: 2000 });
		expect(hotApplyConfig(target, resolved)).toBe(false);
		expect(target.foldForward).toBe(false);
		expect(target.foldThreshold).toBe(2000);
		// 其余字段保持不变（resolved 是完整解析值）。
		expect(target.mediaMaxMB).toBe(20);
	});

	it('连接参数变化时返回 true 且完成合并', () => {
		const target = makeConfig();
		const resolved = makeConfig({ url: 'ws://10.0.0.2:3001', groupMode: 'open' });
		expect(hotApplyConfig(target, resolved)).toBe(true);
		expect(target.url).toBe('ws://10.0.0.2:3001');
		expect(target.groupMode).toBe('open');
	});
});

describe('rateLimitSignature', () => {
	it('窗口或上限变化时签名变化', () => {
		const base = rateLimitSignature({ windowMs: 60000, max: 30 });
		expect(rateLimitSignature({ windowMs: 60000, max: 31 })).not.toBe(base);
		expect(rateLimitSignature({ windowMs: 30000, max: 30 })).not.toBe(base);
		expect(rateLimitSignature({ windowMs: 60000, max: 30 })).toBe(base);
	});
});
