import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersonaStore } from './store.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeStore(): { store: PersonaStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), 'dshqq-persona-'));
	const store = new PersonaStore(dir, logger);
	store.init();
	return { store, dir };
}

describe('PersonaStore 人格库', () => {
	it('首次初始化写入内置默认人格', () => {
		const { store, dir } = makeStore();
		expect(store.list()).toContain('default');
		expect(store.defaultPersonaName()).toBe('default');
		const file = JSON.parse(readFileSync(join(dir, 'personas.json'), 'utf8')) as { default?: string };
		expect(file.default).toBe('default');
	});

	it('setLibrary 整表替换并保存默认人格', () => {
		const { store } = makeStore();
		store.setLibrary(
			[
				{ name: '冷淡', prompt: '话少' },
				{ name: '热情', prompt: '话多' },
			],
			'热情',
		);
		expect(store.list()).toEqual(['冷淡', '热情']);
		expect(store.defaultPersonaName()).toBe('热情');
		expect(store.resolve('u-1')).toEqual({ name: '热情', prompt: '话多' });
	});

	it('默认名不在库里时回落到第一个', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: 'a', prompt: 'A' }], 'missing');
		expect(store.defaultPersonaName()).toBe('a');
	});

	it('setLibrary 丢弃空名、去空白', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: '  x  ', prompt: 'X' }, { name: '   ', prompt: 'ignored' }], null);
		expect(store.list()).toEqual(['x']);
		expect(store.resolve('u-1')).toEqual({ name: 'x', prompt: 'X' });
	});

	it('库为空时回落内置默认提示词', () => {
		const { store } = makeStore();
		store.setLibrary([], null);
		const resolved = store.resolve('u-1');
		expect(resolved.name).toBe('default');
		expect(resolved.prompt).toContain('dsh');
	});
});

describe('PersonaStore 会话覆盖', () => {
	it('会话精确覆盖优先，其次号码级键', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: 'default', prompt: 'D' }, { name: 'g', prompt: 'G' }], 'default');
		store.setMappings([{ key: 'g-123456', persona: 'g' }]);
		// perUser 群会话键先精确匹配（无），再回落到群级 g-<群号>。
		expect(store.resolve(['g-123456-u-42', 'g-123456'])).toEqual({ name: 'g', prompt: 'G' });
		// 精确键有覆盖时优先。
		store.setChatPersona('g-123456-u-42', 'default');
		expect(store.resolve(['g-123456-u-42', 'g-123456'])).toEqual({ name: 'default', prompt: 'D' });
	});

	it('模型覆盖按候选顺序命中第一个', () => {
		const { store } = makeStore();
		store.setMappings([{ key: 'g-1', model: 'provider/group' }]);
		expect(store.getChatModel(['g-1-u-9', 'g-1'])).toBe('provider/group');
		expect(store.getChatModel(['g-2'])).toBeUndefined();
		store.setChatModel('g-1-u-9', 'provider/exact');
		expect(store.getChatModel(['g-1-u-9', 'g-1'])).toBe('provider/exact');
	});

	it('setMappings 只动号码级键，保留 perUser 会话键', () => {
		const { store } = makeStore();
		store.setChatModel('g-1-u-9', 'mine/model');
		store.setMappings([{ key: 'g-1', model: 'group/model' }]);
		expect(store.getChatModel('g-1-u-9')).toBe('mine/model');
		expect(store.mappings()).toEqual([{ key: 'g-1', model: 'group/model' }]);
	});

	it('mappings 忽略空覆盖与 perUser 键', () => {
		const { store } = makeStore();
		store.setChatModel('u-1', 'a/b');
		store.setChatModel('g-1-u-2', 'c/d');
		store.setMappings([{ key: 'u-1', model: 'a/b' }, { key: 'g-1', model: 'c/d' }]);
		expect(store.mappings().map((row) => row.key)).toEqual(['u-1', 'g-1']);
	});

	it('坏文件不致命（回落到内置默认）', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dshqq-persona-bad-'));
		writeFileSync(join(dir, 'personas.json'), '{ not json', 'utf8');
		const store = new PersonaStore(dir, logger);
		store.init();
		expect(store.resolve('u-1').prompt).toContain('dsh');
	});
});

describe('PersonaStore 「默认会话」行', () => {
	it('未配置时为空，配置后作用于没有单独覆盖的会话', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: 'default', prompt: 'D' }, { name: 'hot', prompt: 'H' }], 'default');
		expect(store.defaultMapping()).toBeNull();
		expect(store.defaultModel()).toBeUndefined();
		store.setDefaultMapping({ key: 'default', persona: 'hot', model: 'a/b' });
		expect(store.defaultMapping()).toEqual({ key: 'default', persona: 'hot', model: 'a/b' });
		expect(store.defaultModel()).toBe('a/b');
		expect(store.resolve('u-1')).toEqual({ name: 'hot', prompt: 'H' });
		// 号码级覆盖仍然优先于默认行。
		store.setMappings([{ key: 'u-1', persona: 'default' }]);
		expect(store.resolve('u-1')).toEqual({ name: 'default', prompt: 'D' });
		expect(store.resolve('u-2')).toEqual({ name: 'hot', prompt: 'H' });
	});

	it('默认行不进 mappings()，也不被 setMappings 抹掉', () => {
		const { store } = makeStore();
		store.setDefaultMapping({ key: 'default', model: 'a/b' });
		store.setMappings([{ key: 'u-1', model: 'c/d' }]);
		expect(store.mappings()).toEqual([{ key: 'u-1', model: 'c/d' }]);
		expect(store.defaultMapping()).toEqual({ key: 'default', model: 'a/b' });
		// perUser 会话键也不会被默认行影响。
		store.setChatModel('g-1-u-9', 'mine/model');
		expect(store.getChatModel(['g-1-u-9'])).toBe('mine/model');
	});

	it('默认行人格不在库里时回落到库默认', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: 'default', prompt: 'D' }], 'default');
		store.setDefaultMapping({ key: 'default', persona: 'missing' });
		expect(store.resolve('u-1')).toEqual({ name: 'default', prompt: 'D' });
	});

	it('清空默认行（null）恢复库默认', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: 'default', prompt: 'D' }, { name: 'hot', prompt: 'H' }], 'default');
		store.setDefaultMapping({ key: 'default', persona: 'hot', model: 'a/b' });
		store.setDefaultMapping(null);
		expect(store.defaultMapping()).toBeNull();
		expect(store.defaultModel()).toBeUndefined();
		expect(store.resolve('u-1')).toEqual({ name: 'default', prompt: 'D' });
	});

	it('setLibrary 不传默认名时保留原默认人格', () => {
		const { store } = makeStore();
		store.setLibrary([{ name: 'a', prompt: 'A' }, { name: 'b', prompt: 'B' }], 'b');
		store.setLibrary([{ name: 'a', prompt: 'A2' }, { name: 'b', prompt: 'B' }], null);
		expect(store.defaultPersonaName()).toBe('b');
		// 默认人格被删掉时回落到第一个。
		store.setLibrary([{ name: 'a', prompt: 'A2' }], null);
		expect(store.defaultPersonaName()).toBe('a');
	});
});
