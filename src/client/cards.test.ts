import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_CARD_KEY } from './cards.ts';

type CardsModule = typeof import('./cards.ts');

/** 模块级内存态在用例间必须隔离：每个用例重新 import 一份。 */
let cards: CardsModule;
beforeEach(async () => {
	vi.resetModules();
	cards = await import('./cards.ts');
});

/** 最小 sessionStorage 替身（只实现本模块用到的读写）。 */
function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
		clear: () => data.clear(),
	};
}

function installWindow(storage: unknown): void {
	(globalThis as { window?: unknown }).window = { sessionStorage: storage };
}

afterEach(() => {
	delete (globalThis as { window?: unknown }).window;
});

describe('设置页导航选中项', () => {
	it('没有 window（node/旧宿主）时不抛错，退化为进程内状态', () => {
		expect(cards.readActiveCard()).toBe('connection');
		cards.writeActiveCard('memory');
		expect(cards.readActiveCard()).toBe('memory');
	});

	it('写入会落 sessionStorage，重新读取（模拟刷新/重挂载）仍保持', () => {
		const storage = fakeStorage();
		installWindow(storage);
		cards.writeActiveCard('session');
		expect(storage.data.get(ACTIVE_CARD_KEY)).toBe('session');
		expect(cards.readActiveCard()).toBe('session');
	});

	it('sessionStorage 抛错（隐私模式）时仍可用', () => {
		installWindow({
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			},
		});
		expect(cards.readActiveCard()).toBe('connection');
		cards.writeActiveCard('roster');
		expect(cards.readActiveCard()).toBe('roster');
	});

	it('导航选中项跨刷新保留，未知 id 回退到第一张卡片', () => {
		const storage = fakeStorage();
		installWindow(storage);
		expect(cards.readActiveCard()).toBe('connection');
		cards.writeActiveCard('memory');
		expect(storage.data.get(ACTIVE_CARD_KEY)).toBe('memory');
		expect(cards.readActiveCard()).toBe('memory');
		storage.data.set(ACTIVE_CARD_KEY, 'notACard');
		expect(cards.readActiveCard('session')).toBe('session');
	});

	it('旧卡片 id 迁移到合并后的卡片：souls → personas', () => {
		const storage = fakeStorage({ [ACTIVE_CARD_KEY]: 'souls' });
		installWindow(storage);
		expect(cards.readActiveCard()).toBe('personas');
	});

	it('四张旧卡片迁移到「对话与互动」：wake/reply/media/ask → behavior', () => {
		for (const legacy of ['wake', 'reply', 'media', 'ask']) {
			installWindow(fakeStorage({ [ACTIVE_CARD_KEY]: legacy }));
			expect(cards.readActiveCard(), legacy).toBe('behavior');
		}
	});

	it('「聊天记录」迁移到「成员与信息」：history → roster', () => {
		installWindow(fakeStorage({ [ACTIVE_CARD_KEY]: 'history' }));
		expect(cards.readActiveCard()).toBe('roster');
	});

	it('已删除的「记忆库与技能」卡迁移到「长期记忆」：memoryItems → memory', () => {
		installWindow(fakeStorage({ [ACTIVE_CARD_KEY]: 'memoryItems' }));
		expect(cards.readActiveCard()).toBe('memory');
	});
});
