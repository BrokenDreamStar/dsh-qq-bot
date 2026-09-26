import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceOverrides } from './workspaces.ts';

function tmpDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'dsh-qq-ws-'));
}

describe('WorkspaceOverrides', () => {
	it('空目录加载为空表', () => {
		const store = WorkspaceOverrides.load(tmpDataDir());
		expect(store.get('u-1')).toBeUndefined();
	});

	it('set/clear 持久化，可跨实例恢复（重启语义）', () => {
		const dir = tmpDataDir();
		WorkspaceOverrides.load(dir).set('u-1', '/tmp/project-a');
		expect(WorkspaceOverrides.load(dir).get('u-1')).toBe('/tmp/project-a');
		WorkspaceOverrides.load(dir).clear('u-1');
		expect(WorkspaceOverrides.load(dir).get('u-1')).toBeUndefined();
	});

	it('clear 不存在的键不写盘', () => {
		const dir = tmpDataDir();
		WorkspaceOverrides.load(dir).clear('u-1');
		expect(WorkspaceOverrides.load(dir).get('u-1')).toBeUndefined();
	});

	it('损坏文件视为空表且可继续覆写', () => {
		const dir = tmpDataDir();
		writeFileSync(join(dir, 'workspaces.json'), '{broken', 'utf8');
		const store = WorkspaceOverrides.load(dir);
		expect(store.get('u-1')).toBeUndefined();
		store.set('u-1', '/tmp/x');
		expect(WorkspaceOverrides.load(dir).get('u-1')).toBe('/tmp/x');
	});

	it('忽略非字符串与空字符串值', () => {
		const dir = tmpDataDir();
		writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ 'u-1': 42, 'u-2': '', 'u-3': '/ok' }), 'utf8');
		const store = WorkspaceOverrides.load(dir);
		expect(store.get('u-1')).toBeUndefined();
		expect(store.get('u-2')).toBeUndefined();
		expect(store.get('u-3')).toBe('/ok');
	});
});
