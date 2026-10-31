import { describe, expect, it } from 'vitest';
import { en, toolLabel, zh } from './locales.ts';
import { CHAT_TOOLS } from '../bridge/toolGuard.ts';

/** 模拟 ctx.locale.bind：命中返回文案，未命中回退 key（与 dsh-client-locale 一致）。 */
function bind(dict: Record<string, string>) {
	return (key: string): string => dict[key] ?? key;
}

describe('toolLabel（工具勾选框的显示名）', () => {
	it('字典里有 tool.<id> 时返回中文名', () => {
		expect(toolLabel(bind(zh), 'qq_send')).toBe('发送 QQ 消息');
	});

	it('英文环境返回英文名', () => {
		expect(toolLabel(bind(en), 'qq_send')).toBe('Send QQ message');
	});

	it('字典里没有的工具回退成工具 id（新装的 dsh 插件 / 手填通配条目）', () => {
		expect(toolLabel(bind(zh), 'brand_new_tool')).toBe('brand_new_tool');
		expect(toolLabel(bind(zh), 'web*')).toBe('web*');
	});

	it('对话工具与网页搜索/记忆工具都有中英文显示名', () => {
		const names = [...CHAT_TOOLS, 'qq_web_search', 'qq_recall_memory', 'qq_memorize'];
		for (const name of names) {
			expect(toolLabel(bind(zh), name)).not.toBe(name);
			expect(toolLabel(bind(en), name)).not.toBe(name);
		}
	});

	it('中英文字典的 tool.* 条目成对', () => {
		const keysOf = (dict: Record<string, string>) => Object.keys(dict).filter((key) => key.startsWith('tool.')).sort();
		expect(keysOf(en)).toEqual(keysOf(zh));
	});
});
