import { describe, expect, it } from 'vitest';
import { CHAT_TOOLS, decideTool, matchToolPattern } from './toolGuard.ts';

describe('matchToolPattern', () => {
	it('精确匹配', () => {
		expect(matchToolPattern('shell', 'shell')).toBe(true);
		expect(matchToolPattern('shell', 'shellx')).toBe(false);
	});

	it('尾部 * 前缀通配', () => {
		expect(matchToolPattern('read*', 'read_file')).toBe(true);
		expect(matchToolPattern('read*', 'readx_file')).toBe(true);
		expect(matchToolPattern('read*', 'write_file')).toBe(false);
		expect(matchToolPattern('mcp__*', 'mcp__server__tool')).toBe(true);
	});

	it('单独 * 匹配全部', () => {
		expect(matchToolPattern('*', 'anything')).toBe(true);
	});

	it('空白容错', () => {
		expect(matchToolPattern(' shell ', 'shell')).toBe(true);
	});
});

describe('decideTool', () => {
	const base = { name: 'shell', userTools: [] as string[], blockedTools: [] as string[] };

	it('管理员全量放行', () => {
		expect(decideTool({ ...base, isAdmin: true }).allowed).toBe(true);
	});

	it('普通用户默认全拒（纯对话）', () => {
		const decision = decideTool({ ...base, isAdmin: false });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain('仅管理员可用');
	});

	it('普通用户可用 userTools 白名单', () => {
		expect(decideTool({ name: 'web_search', isAdmin: false, userTools: ['web_search'], blockedTools: [] }).allowed).toBe(true);
		expect(decideTool({ name: 'web_fetch', isAdmin: false, userTools: ['web_*'], blockedTools: [] }).allowed).toBe(true);
		expect(decideTool({ name: 'shell', isAdmin: false, userTools: ['web_*'], blockedTools: [] }).allowed).toBe(false);
	});

	it('blockedTools 连管理员也拦', () => {
		const decision = decideTool({ ...base, isAdmin: true, blockedTools: ['shell'] });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain('blockedTools');
	});

	it('blockedTools 通配对所有匹配工具生效', () => {
		expect(decideTool({ name: 'run_code', isAdmin: true, userTools: [], blockedTools: ['run*'] }).allowed).toBe(false);
	});

	it('黑名单优先级高于 userTools 白名单', () => {
		const decision = decideTool({ name: 'shell', isAdmin: false, userTools: ['shell'], blockedTools: ['shell'] });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain('blockedTools');
	});

	it('聊天工具对普通用户永久放行', () => {
		for (const name of CHAT_TOOLS) {
			expect(decideTool({ name, isAdmin: false, userTools: [], blockedTools: [] }).allowed).toBe(true);
		}
	});

	it('聊天工具仍受 blockedTools 约束', () => {
		expect(decideTool({ name: 'qq_send', isAdmin: false, userTools: [], blockedTools: ['qq_send'] }).allowed).toBe(false);
	});
});
