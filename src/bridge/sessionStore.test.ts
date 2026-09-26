import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatSessionStore, LEGACY_SESSION_MARKER, legacySessionMarkerPath, readLegacySessionMarker } from './sessionStore.ts';

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe('ChatSessionStore', () => {
	it('写入后可跨实例读回（模拟重启）', () => {
		const dataDir = tempDir('dshqq-sess-');
		ChatSessionStore.load(dataDir).set('u-10001', 'qq-private-10001-reset-1');
		expect(ChatSessionStore.load(dataDir).get('u-10001')).toBe('qq-private-10001-reset-1');
	});

	it('按 chatKey 隔离，未记录的键为 undefined', () => {
		const dataDir = tempDir('dshqq-sess-');
		const store = ChatSessionStore.load(dataDir);
		store.set('u-10001', 'a');
		store.set('g-20002', 'b');
		expect(store.get('u-10001')).toBe('a');
		expect(store.get('g-20002')).toBe('b');
		expect(store.get('g-20003')).toBeUndefined();
	});

	it('文件缺失或损坏视为空表（不抛错）', () => {
		expect(ChatSessionStore.load(tempDir('dshqq-sess-')).get('u-1')).toBeUndefined();
		const dataDir = tempDir('dshqq-sess-');
		writeFileSync(join(dataDir, 'chat-sessions.json'), '{ this is not json', 'utf8');
		expect(ChatSessionStore.load(dataDir).get('u-1')).toBeUndefined();
	});

	it('忽略非字符串 / 空值条目', () => {
		const dataDir = tempDir('dshqq-sess-');
		writeFileSync(join(dataDir, 'chat-sessions.json'), JSON.stringify({ 'u-1': 'ok', 'u-2': '', 'u-3': 42, 'u-4': null }), 'utf8');
		const store = ChatSessionStore.load(dataDir);
		expect(store.get('u-1')).toBe('ok');
		expect(store.get('u-2')).toBeUndefined();
		expect(store.get('u-3')).toBeUndefined();
		expect(store.get('u-4')).toBeUndefined();
	});

	it('keys() 列出全部 chatKey（启动预热按它遍历）', () => {
		const dataDir = tempDir('dshqq-sess-');
		const store = ChatSessionStore.load(dataDir);
		store.set('u-10001', 'a');
		store.set('g-20002', 'b');
		expect(store.keys().sort()).toEqual(['g-20002', 'u-10001']);
		expect(ChatSessionStore.load(tempDir('dshqq-sess-')).keys()).toEqual([]);
	});
});

describe('旧版会话标记（迁移读取）', () => {
	it('文件存在时读出会话 id', () => {
		const workspaceDir = tempDir('dshqq-ws-');
		writeFileSync(legacySessionMarkerPath(workspaceDir), 'qq-private-10001-reset-1\n', 'utf8');
		expect(readLegacySessionMarker(workspaceDir)).toBe('qq-private-10001-reset-1');
		expect(legacySessionMarkerPath(workspaceDir)).toBe(join(workspaceDir, LEGACY_SESSION_MARKER));
	});

	it('工作目录被清理过（文件或空内容）时返回 undefined', () => {
		expect(readLegacySessionMarker(tempDir('dshqq-ws-'))).toBeUndefined();
		const workspaceDir = tempDir('dshqq-ws-');
		writeFileSync(legacySessionMarkerPath(workspaceDir), '   \n', 'utf8');
		expect(readLegacySessionMarker(workspaceDir)).toBeUndefined();
	});
});
