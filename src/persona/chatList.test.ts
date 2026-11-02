import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatDirectory } from './chatList.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** 建一个临时会话根目录，并按名字创建若干会话目录。 */
function makeSessionsRoot(dirs: readonly string[] = []): string {
	const root = join(mkdtempSync(join(tmpdir(), 'dshqq-chatlist-')), 'sessions');
	mkdirSync(root, { recursive: true });
	for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
	return root;
}

describe('ChatDirectory', () => {
	it('合并 QQ 群 / 好友、本地会话目录与已保存行，群在前', async () => {
		const directory = new ChatDirectory({
			sessionsRoot: makeSessionsRoot(['Group_200', 'Friend_300']),
			savedKeys: () => ['g-999', 'u-888', 'g-1-u-2', 'default'],
			listGroups: async () => [
				{ id: '100', name: 'Beta group' },
				{ id: '200', name: 'Alpha group' },
			],
			listFriends: async () => [{ id: '100', name: 'Alice' }],
			logger,
		});
		const options = await directory.list();
		// 群：有名字的按名字排（Alpha 200 → Beta 100），无名字的排后面（按号码）。
		// 私聊同理；perUser 群键（g-1-u-2）与默认行不是号码级选择器，不进清单。
		expect(options.map((option) => option.chat)).toEqual([
			'group_200',
			'group_100',
			'group_999',
			'friend_100',
			'friend_300',
			'friend_888',
		]);
		expect(options[0]).toEqual({ chat: 'group_200', kind: 'group', id: '200', name: 'Alpha group' });
		// 本地目录扫出来的会话没有名字。
		expect(options.find((option) => option.chat === 'friend_300')?.name).toBeUndefined();
	});

	it('QQ 清单不可用时退化为本地清单，且不把失败结果缓存住', async () => {
		const listGroups = vi.fn(async () => {
			throw new Error('not connected');
		});
		const listFriends = vi.fn(async () => undefined);
		const directory = new ChatDirectory({
			sessionsRoot: makeSessionsRoot(['Group_7']),
			savedKeys: () => [],
			listGroups,
			listFriends,
			logger,
		});
		expect((await directory.list()).map((option) => option.chat)).toEqual(['group_7']);
		// 失败 → 下次打开设置页重试（不缓存空清单）。
		await directory.list();
		expect(listGroups).toHaveBeenCalledTimes(2);
	});

	it('远端清单在 TTL 内只拉一次', async () => {
		let now = 0;
		const listGroups = vi.fn(async () => [{ id: '1', name: 'G' }]);
		const listFriends = vi.fn(async () => [{ id: '2', name: 'F' }]);
		const directory = new ChatDirectory({
			sessionsRoot: makeSessionsRoot(),
			savedKeys: () => [],
			listGroups,
			listFriends,
			logger,
			ttlMs: 1000,
			now: () => now,
		});
		await directory.list();
		await directory.list();
		expect(listGroups).toHaveBeenCalledTimes(1);
		expect(listFriends).toHaveBeenCalledTimes(1);
		now = 1500;
		await directory.list();
		expect(listGroups).toHaveBeenCalledTimes(2);
	});

	it('本地新增会话不受远端缓存影响（目录扫描每次都跑）', async () => {
		const sessionsRoot = makeSessionsRoot();
		const directory = new ChatDirectory({
			sessionsRoot,
			savedKeys: () => [],
			listGroups: async () => [],
			listFriends: async () => [],
			logger,
		});
		expect(await directory.list()).toEqual([]);
		mkdirSync(join(sessionsRoot, 'Group_42'), { recursive: true });
		expect((await directory.list()).map((option) => option.chat)).toEqual(['group_42']);
	});

	it('已保存行在会话目录被删后仍能回显', async () => {
		const directory = new ChatDirectory({
			sessionsRoot: makeSessionsRoot(),
			savedKeys: () => ['g-123'],
			logger,
		});
		expect(await directory.list()).toEqual([{ chat: 'group_123', kind: 'group', id: '123' }]);
	});
});
