import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handlePersonaRpc, listModelOptions, parseMappingRows, type PersonaRpcDeps } from './rpc.ts';
import { PersonaStore } from './store.ts';
import type { LlmServiceLike } from '../dsh.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeDeps(overrides?: Partial<PersonaRpcDeps>): { deps: PersonaRpcDeps; store: PersonaStore; refresh: ReturnType<typeof vi.fn> } {
	const dir = mkdtempSync(join(tmpdir(), 'dshqq-rpc-'));
	const store = new PersonaStore(dir, logger);
	store.init();
	const refresh = vi.fn(async () => {});
	const deps: PersonaRpcDeps = {
		store,
		refreshBridges: refresh,
		logger,
		getDefaultModel: () => ({ provider: 'dsh', model: 'base' }),
		...overrides,
	};
	return { deps, store, refresh };
}

describe('parseMappingRows', () => {
	it('归一 friend_/group_ 为内部键，去掉空值', () => {
		const { rows, invalid } = parseMappingRows([
			{ chat: 'friend_10001', persona: '冷淡', model: '' },
			{ chat: 'group:123456', model: 'deepseek/deepseek-chat' },
			{ chat: '' },
		]);
		expect(invalid).toEqual(['(空)']);
		expect(rows).toEqual([
			{ key: 'u-10001', persona: '冷淡' },
			{ key: 'g-123456', model: 'deepseek/deepseek-chat' },
		]);
	});

	it('重复号码后者覆盖前者', () => {
		const { rows } = parseMappingRows([
			{ chat: 'group_1', model: 'a/b' },
			{ chat: 'group_1', model: 'c/d' },
		]);
		expect(rows).toEqual([{ key: 'g-1', model: 'c/d' }]);
	});

	it('无法识别的选择器汇总进 invalid', () => {
		const { invalid } = parseMappingRows([{ chat: 'wechat_1' }]);
		expect(invalid).toEqual(['wechat_1']);
	});

	it('非数组视为空表', () => {
		expect(parseMappingRows(undefined)).toEqual({ rows: [], invalid: ['rows 必须是数组'] });
	});
});

describe('listModelOptions', () => {
	it('枚举 provider 模型并置顶部署默认', async () => {
		const llm: LlmServiceLike = {
			listProviders: () => ['dsh', { id: 'openai', name: 'OpenAI' }],
			listModels: async (provider) => (provider === 'dsh' ? [{ id: 'base', name: 'Base' }] : [{ id: 'gpt', name: 'GPT' }]),
		};
		const options = await listModelOptions({ getLlm: () => llm, getDefaultModel: () => ({ provider: 'dsh', model: 'base' }), logger });
		expect(options.map((option) => option.spec)).toEqual(['dsh/base', 'openai/gpt']);
		expect(options[1]).toMatchObject({ provider: 'openai', model: 'gpt', name: 'GPT' });
	});

	it('llm 缺失时只有部署默认', async () => {
		const options = await listModelOptions({ getLlm: () => undefined, getDefaultModel: () => ({ provider: 'dsh', model: 'base' }), logger });
		expect(options.map((option) => option.spec)).toEqual(['dsh/base']);
	});

	it('单个 provider 枚举失败不影响其余', async () => {
		const llm: LlmServiceLike = {
			listProviders: () => ['bad', 'good'],
			listModels: async (provider) => {
				if (provider === 'bad') throw new Error('boom');
				return [{ id: 'm' }];
			},
		};
		const options = await listModelOptions({ getLlm: () => llm, logger });
		expect(options.map((option) => option.spec)).toEqual(['good/m']);
	});
});

describe('handlePersonaRpc', () => {
	it('personas/list 返回人格库与默认名', async () => {
		const { deps } = makeDeps();
		const result = await handlePersonaRpc('personas/list', undefined, deps);
		expect(result).toMatchObject({ ok: true, value: { default: 'default' } });
	});

	it('personas/save 落库并触发会话重建', async () => {
		const { deps, store, refresh } = makeDeps();
		const result = await handlePersonaRpc('personas/save', { personas: [{ name: 'x', prompt: 'X' }], default: 'x' }, deps);
		expect(result).toMatchObject({ ok: true });
		expect(store.defaultPersonaName()).toBe('x');
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('personas/save 拒绝空名', async () => {
		const { deps, refresh } = makeDeps();
		const result = await handlePersonaRpc('personas/save', { personas: [{ name: '  ', prompt: 'X' }] }, deps);
		expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
		expect(refresh).not.toHaveBeenCalled();
	});

	it('routes/save 写入映射，非法选择器整体拒绝', async () => {
		const { deps, store, refresh } = makeDeps();
		const good = await handlePersonaRpc('routes/save', { rows: [{ chat: 'friend_1', persona: 'default', model: 'dsh/base' }] }, deps);
		expect(good).toMatchObject({ ok: true });
		expect(store.getChatModel('u-1')).toBe('dsh/base');
		const bad = await handlePersonaRpc('routes/save', { rows: [{ chat: 'nope' }] }, deps);
		expect(bad).toMatchObject({ ok: false, error: { code: 'invalid' } });
		// 非法保存不覆盖上一次成功的结果。
		expect(store.getChatModel('u-1')).toBe('dsh/base');
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('routes/list 回显 friend_/group_ 写法', async () => {
		const { deps } = makeDeps();
		await handlePersonaRpc('routes/save', { rows: [{ chat: 'group_9', model: 'a/b' }] }, deps);
		const result = await handlePersonaRpc('routes/list', undefined, deps);
		expect(result).toMatchObject({ ok: true, value: { rows: [{ chat: 'group_9', model: 'a/b' }] } });
	});

	it('routes/save 的默认会话行落到 default 保留键并即时生效', async () => {
		const { deps, store, refresh } = makeDeps();
		const saved = await handlePersonaRpc('routes/save', { rows: [], default: { persona: 'default', model: 'dsh/base' } }, deps);
		expect(saved).toMatchObject({ ok: true, value: { default: { persona: 'default', model: 'dsh/base' } } });
		expect(store.defaultModel()).toBe('dsh/base');
		const listed = await handlePersonaRpc('routes/list', undefined, deps);
		expect(listed).toMatchObject({ ok: true, value: { default: { persona: 'default', model: 'dsh/base' }, libraryDefault: 'default' } });
		// 默认行不混进号码行。
		expect(store.mappings()).toEqual([]);
		// 显式清空默认行。
		const cleared = await handlePersonaRpc('routes/save', { rows: [], default: {} }, deps);
		expect(cleared).toMatchObject({ ok: true, value: { default: {} } });
		expect(store.defaultMapping()).toBeNull();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('routes/save 不带 default 字段时保留默认行（老客户端）', async () => {
		const { deps, store } = makeDeps();
		await handlePersonaRpc('routes/save', { rows: [], default: { model: 'a/b' } }, deps);
		await handlePersonaRpc('routes/save', { rows: [{ chat: 'friend_1', model: 'c/d' }] }, deps);
		expect(store.defaultModel()).toBe('a/b');
	});

	it('personas/save 不带 default 时保留库默认人格', async () => {
		const { deps, store } = makeDeps();
		await handlePersonaRpc('personas/save', { personas: [{ name: 'a', prompt: 'A' }, { name: 'b', prompt: 'B' }], default: 'b' }, deps);
		await handlePersonaRpc('personas/save', { personas: [{ name: 'a', prompt: 'A2' }, { name: 'b', prompt: 'B' }] }, deps);
		expect(store.defaultPersonaName()).toBe('b');
	});

	it('未知端点返回 undefined', async () => {
		const { deps } = makeDeps();
		expect(await handlePersonaRpc('logs/recent', undefined, deps)).toBeUndefined();
	});
});
