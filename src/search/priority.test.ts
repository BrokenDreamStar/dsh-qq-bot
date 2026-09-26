import { describe, expect, it } from 'vitest';
import { addOrderItem, moveOrderItem, removeOrderItem } from './priority.ts';

describe('moveOrderItem', () => {
	it('上移/下移交换相邻两项', () => {
		expect(moveOrderItem(['exa', 'tavily', 'dsh'], 2, -1)).toEqual(['exa', 'dsh', 'tavily']);
		expect(moveOrderItem(['exa', 'tavily', 'dsh'], 0, 1)).toEqual(['tavily', 'exa', 'dsh']);
	});

	it('越界时原样返回（第一项上移、最后一项下移、index 不存在）', () => {
		expect(moveOrderItem(['exa', 'tavily'], 0, -1)).toEqual(['exa', 'tavily']);
		expect(moveOrderItem(['exa', 'tavily'], 1, 1)).toEqual(['exa', 'tavily']);
		expect(moveOrderItem(['exa'], 5, -1)).toEqual(['exa']);
		expect(moveOrderItem([], 0, 1)).toEqual([]);
	});

	it('不改动传入的数组（纯函数）', () => {
		const items = ['exa', 'tavily'];
		const next = moveOrderItem(items, 0, 1);
		expect(items).toEqual(['exa', 'tavily']);
		expect(next).not.toBe(items);
	});
});

describe('addOrderItem / removeOrderItem', () => {
	it('加入列表追加到末尾，已存在不重复', () => {
		expect(addOrderItem(['tavily'], 'exa')).toEqual(['tavily', 'exa']);
		expect(addOrderItem(['tavily', 'exa'], 'exa')).toEqual(['tavily', 'exa']);
		expect(addOrderItem([], 'dsh')).toEqual(['dsh']);
	});

	it('移出列表删掉该项，不存在时原样返回', () => {
		expect(removeOrderItem(['exa', 'tavily', 'dsh'], 'tavily')).toEqual(['exa', 'dsh']);
		expect(removeOrderItem(['exa'], 'dsh')).toEqual(['exa']);
		expect(removeOrderItem(['exa'], 'exa')).toEqual([]);
	});

	it('都不改动传入的数组（纯函数）', () => {
		const items = ['exa'];
		expect(addOrderItem(items, 'tavily')).not.toBe(items);
		expect(removeOrderItem(items, 'exa')).not.toBe(items);
		expect(items).toEqual(['exa']);
	});
});
