import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_CARDS_KEY } from './cards.ts';

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

describe('设置页卡片展开态', () => {
	it('没有 window（node/旧宿主）时不抛错，退化为进程内状态', () => {
		expect(cards.readOpenCards()).toEqual({});
		cards.writeOpenCard('wake', true);
		expect(cards.readOpenCards().wake).toBe(true);
		cards.writeOpenCard('wake', false);
		expect(cards.readOpenCards().wake).toBeUndefined();
	});

	it('写入会落 sessionStorage，重新读取（模拟刷新/重挂载）仍保持展开', () => {
		const storage = fakeStorage();
		installWindow(storage);
		cards.writeOpenCard('wake', true);
		expect(JSON.parse(storage.data.get(OPEN_CARDS_KEY) ?? '{}')).toEqual({ wake: true });
		expect(cards.readOpenCards()).toEqual({ wake: true });
		// 折叠即从存储里移除（不留 false 残键）。
		cards.writeOpenCard('wake', false);
		expect(JSON.parse(storage.data.get(OPEN_CARDS_KEY) ?? '{}')).toEqual({});
	});

	it('只认 FIELD_GROUPS 里的卡片 id 与 true，脏数据被丢弃', () => {
		const storage = fakeStorage({
			[OPEN_CARDS_KEY]: JSON.stringify({ wake: true, notACard: true, connection: false, tools: 'yes' }),
		});
		installWindow(storage);
		expect(cards.readOpenCards()).toEqual({ wake: true });
	});

	it('存储里是非法 JSON 时不影响渲染', () => {
		const storage = fakeStorage({ [OPEN_CARDS_KEY]: '{oops' });
		installWindow(storage);
		expect(cards.readOpenCards()).toEqual({});
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
		expect(cards.readOpenCards()).toEqual({});
		cards.writeOpenCard('reply', true);
		expect(cards.readOpenCards()).toEqual({ reply: true });
	});
});
