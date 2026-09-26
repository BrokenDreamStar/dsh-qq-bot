import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceImage } from './index.ts';

describe('resolveWorkspaceImage', () => {
	it('允许会话目录内的文件', () => {
		const ws = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		const file = join(ws, 'a.png');
		writeFileSync(file, 'x');
		expect(resolveWorkspaceImage({ sessionDir: ws, agentCwd: ws }, file)).toBe(file);
	});

	it('允许 agent 工作目录内的文件（/cwd 切换后）', () => {
		const ws = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		const cwd = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		const file = join(cwd, 'b.png');
		writeFileSync(file, 'x');
		expect(resolveWorkspaceImage({ sessionDir: ws, agentCwd: cwd }, file)).toBe(file);
	});

	it('两个根之外的文件拒绝', () => {
		const ws = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		expect(() => resolveWorkspaceImage({ sessionDir: ws, agentCwd: ws }, join(tmpdir(), 'other.png'))).toThrow(/允许的目录/);
	});

	it('前缀重叠但目录不同的路径不误判（a 不放行 ab）', () => {
		const base = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		const ws = join(base, 'a');
		const sibling = join(base, 'ab');
		mkdirSync(ws, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		const inWs = join(ws, 'c.png');
		const inSibling = join(sibling, 'd.png');
		writeFileSync(inWs, 'x');
		writeFileSync(inSibling, 'x');
		expect(resolveWorkspaceImage({ sessionDir: ws, agentCwd: ws }, inWs)).toBe(inWs);
		expect(() => resolveWorkspaceImage({ sessionDir: ws, agentCwd: ws }, inSibling)).toThrow(/允许的目录/);
	});

	it('相对路径落到进程 cwd，不在允许目录内则拒绝', () => {
		expect(() => resolveWorkspaceImage({ sessionDir: '/ws', agentCwd: '/ws' }, 'a.png')).toThrow(/允许的目录/);
	});

	it('不存在的文件拒绝', () => {
		const ws = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		expect(() => resolveWorkspaceImage({ sessionDir: ws, agentCwd: ws }, join(ws, 'nope.png'))).toThrow(/不存在/);
	});

	it('目录不是文件', () => {
		const ws = mkdtempSync(join(tmpdir(), 'dsh-qq-img-'));
		expect(() => resolveWorkspaceImage({ sessionDir: ws, agentCwd: ws }, ws)).toThrow(/不是文件/);
	});
});
