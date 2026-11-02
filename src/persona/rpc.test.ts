import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
	const sessionsRoot = join(dir, 'sessions');
	mkdirSync(sessionsRoot, { recursive: true });
	const refresh = vi.fn(async () => {});
	const deps: PersonaRpcDeps = {
		store,
		sessionsRoot,
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

	it('带出每个模型的思考强度与默认强度，并标记部署默认项', async () => {
		const llm: LlmServiceLike = {
			listProviders: () => ['dsh'],
			listModels: async () => [{ id: 'base', name: 'Base' }],
			resolveModelInfo: async (_provider: string, model: string) => ({
				id: model,
				reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高', description: '慢而稳' }], defaultEffort: 'low' },
			}),
		};
		const options = await listModelOptions({ getLlm: () => llm, getDefaultModel: () => ({ provider: 'dsh', model: 'base' }), logger });
		expect(options[0]).toMatchObject({ spec: 'dsh/base', isDefault: true, defaultEffort: 'low' });
		expect(options[0]?.efforts.map((effort) => effort.id)).toEqual(['low', 'high']);
		expect(options[0]?.efforts[1]).toMatchObject({ name: '高', description: '慢而稳' });
	});

	it('resolveModelInfo 抛错时只丢强度，不影响模型清单', async () => {
		const llm: LlmServiceLike = {
			listProviders: () => ['dsh'],
			listModels: async () => [{ id: 'base' }],
			resolveModelInfo: async () => {
				throw new Error('boom');
			},
		};
		const options = await listModelOptions({ getLlm: () => llm, getDefaultModel: () => ({ provider: 'dsh', model: 'base' }), logger });
		expect(options.map((option) => option.spec)).toEqual(['dsh/base']);
		expect(options[0]?.efforts).toEqual([]);
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

	it('routes/save 的默认会话行落到 default 保留键并即时生效（模型 + 思考强度）', async () => {
		const { deps, store, refresh } = makeDeps();
		const saved = await handlePersonaRpc('routes/save', { rows: [], default: { model: 'dsh/base', effort: 'high' } }, deps);
		expect(saved).toMatchObject({ ok: true, value: { default: { model: 'dsh/base', effort: 'high' } } });
		expect(store.defaultModel()).toBe('dsh/base');
		expect(store.defaultEffort()).toBe('high');
		const listed = await handlePersonaRpc('routes/list', undefined, deps);
		expect(listed).toMatchObject({ ok: true, value: { default: { model: 'dsh/base', effort: 'high' }, libraryDefault: 'default' } });
		// 默认行不混进号码行。
		expect(store.mappings()).toEqual([]);
		// 显式清空默认行。
		const cleared = await handlePersonaRpc('routes/save', { rows: [], default: {} }, deps);
		expect(cleared).toMatchObject({ ok: true, value: { default: {} } });
		expect(store.defaultMapping()).toBeNull();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('routes/save 带思考强度：号码行回显 effort，且不抹掉旧版人格列', async () => {
		const { deps, store } = makeDeps();
		await handlePersonaRpc('personas/save', { personas: [{ name: 'default', prompt: 'D' }, { name: '冷淡', prompt: '话少' }] }, deps);
		await handlePersonaRpc('routes/save', { rows: [{ chat: 'friend_7', persona: '冷淡', model: 'a/b' }] }, deps);
		await handlePersonaRpc('routes/save', { rows: [{ chat: 'friend_7', model: 'a/b', effort: 'max' }] }, deps);
		const listed = await handlePersonaRpc('routes/list', undefined, deps);
		expect(listed).toMatchObject({ ok: true, value: { rows: [{ chat: 'friend_7', model: 'a/b', effort: 'max' }] } });
		expect(store.resolve('u-7').name).toBe('冷淡');
	});

	it('personas/default 只改新会话默认模板，保留同一行的模型与强度', async () => {
		const { deps, store } = makeDeps();
		await handlePersonaRpc('routes/save', { rows: [], default: { model: 'dsh/base', effort: 'low' } }, deps);
		await handlePersonaRpc('personas/save', { personas: [{ name: 'a', prompt: 'A' }, { name: 'b', prompt: 'B' }] }, deps);
		const saved = await handlePersonaRpc('personas/default', { name: 'b' }, deps);
		expect(saved).toMatchObject({ ok: true, value: { defaultTemplate: 'b' } });
		expect(store.defaultPersonaSeed()).toBe('b');
		expect(store.defaultModel()).toBe('dsh/base');
		expect(store.defaultEffort()).toBe('low');
		// 空串 = 回到人格库默认。
		await handlePersonaRpc('personas/default', { name: '' }, deps);
		expect(store.defaultPersonaSeed()).toBeUndefined();
		const bad = await handlePersonaRpc('personas/default', { name: 'missing' }, deps);
		expect(bad).toMatchObject({ ok: false, error: { code: 'not-found' } });
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

describe('SOUL.md RPC', () => {
	it('list/read/save/apply/reset 都作用于会话目录里的 SOUL.md', async () => {
		const { deps, store, refresh } = makeDeps();
		mkdirSync(join(deps.sessionsRoot, 'Group_888'), { recursive: true });
		store.setLibrary(
			[
				{ name: 'default', prompt: '默认人格' },
				{ name: '冷淡', prompt: '冷淡人格' },
			],
			'default',
		);

		const list = await handlePersonaRpc('souls/list', {}, deps);
		expect(list?.ok).toBe(true);
		if (!list?.ok) return;
		const souls = (list.value as { souls: Array<{ chat: string; exists: boolean; source: string }> }).souls;
		expect(souls).toHaveLength(1);
		expect(souls[0]).toMatchObject({ chat: 'group_888', exists: false, source: 'template' });

		const before = await handlePersonaRpc('souls/read', { chat: 'group_888' }, deps);
		expect(before?.ok).toBe(true);
		if (before?.ok) expect((before.value as { content: string }).content).toBe('默认人格');

		const saved = await handlePersonaRpc('souls/save', { chat: 'group_888', content: '自定义人格' }, deps);
		expect(saved?.ok).toBe(true);
		expect(readFileSync(join(deps.sessionsRoot, 'Group_888', 'SOUL.md'), 'utf8')).toBe('自定义人格');
		expect(refresh).toHaveBeenCalled();

		const after = await handlePersonaRpc('souls/read', { chat: 'group_888' }, deps);
		if (after?.ok) expect(after.value).toMatchObject({ content: '自定义人格', source: 'file' });

		const applied = await handlePersonaRpc('souls/apply', { chat: 'group_888', persona: '冷淡' }, deps);
		expect(applied?.ok).toBe(true);
		expect(readFileSync(join(deps.sessionsRoot, 'Group_888', 'SOUL.md'), 'utf8')).toBe('冷淡人格');

		const reset = await handlePersonaRpc('souls/reset', { chat: 'group_888' }, deps);
		expect(reset?.ok).toBe(true);
		expect(readFileSync(join(deps.sessionsRoot, 'Group_888', 'SOUL.md'), 'utf8')).toBe('默认人格');
	});

	it('非法 chat 与过长内容被拒绝', async () => {
		const { deps } = makeDeps();
		const bad = await handlePersonaRpc('souls/read', { chat: 'wechat_1' }, deps);
		expect(bad?.ok).toBe(false);
		const long = await handlePersonaRpc('souls/save', { chat: 'group_888', content: 'x'.repeat(20_001) }, deps);
		expect(long?.ok).toBe(false);
	});
});
