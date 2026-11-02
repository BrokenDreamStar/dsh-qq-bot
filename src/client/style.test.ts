import { describe, expect, it } from 'vitest';
import { CARD_CSS } from './style.ts';

/** 拆出每条规则的「选择器 → 声明块」，够用来做几条结构性断言。 */
function rules(css: string): Array<{ selector: string; body: string }> {
	const out: Array<{ selector: string; body: string }> = [];
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const selector = match[1]?.trim() ?? '';
		const body = match[2] ?? '';
		if (selector.startsWith('@') || selector === '') continue;
		out.push({ selector, body });
	}
	return out;
}

describe('设置页样式', () => {
	// 宿主的设置页滚动容器（.VOzbGW_options）是 overflow-y:auto，横向只要多出 1px
	// 整页就出现横向滚动条；卡片头这类 div 一旦 width:100% + 左右 padding 而没
	// border-box，就会撑出 32px。这条重置是那类 bug 的总闸。
	it('整棵子树统一 border-box', () => {
		const reset = rules(CARD_CSS).find((rule) => rule.selector.includes('.dshqq-section *'));
		expect(reset).toBeDefined();
		expect(reset?.body).toContain('box-sizing:border-box');
		expect(reset?.selector).toContain('.dshqq-section,');
	});

	it('写死宽度的规则要么走 border-box，要么有 border-box 重置兜着', () => {
		const hasReset = CARD_CSS.includes('.dshqq-section *');
		const wide = rules(CARD_CSS).filter((rule) => /width:(100%|calc\()/.test(rule.body));
		expect(wide.length).toBeGreaterThan(0);
		for (const rule of wide) {
			expect(hasReset || rule.body.includes('box-sizing:border-box')).toBe(true);
		}
	});

	it('勾选网格的最小轨道不会超过容器（窄窗口也不出横向滚动条）', () => {
		expect(CARD_CSS).toContain('repeat(auto-fill,minmax(min(170px,100%),1fr))');
	});
});
