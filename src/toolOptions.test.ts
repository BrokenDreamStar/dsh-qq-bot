import { describe, expect, it } from 'vitest';
import { attachToolOptions, ConfigSchema } from './config.ts';
import { readToolOptions, TOOL_OPTIONS_META_KEY } from './toolOptions.ts';

describe('readToolOptions（序列化 schema 信封读取）', () => {
	it('从 {uid, refs} 信封里按字段 key 取 meta 选项', () => {
		const envelope = {
			uid: 7,
			refs: {
				'3': { type: 'string', meta: {} },
				'5': { type: 'array', meta: { [TOOL_OPTIONS_META_KEY]: ['bash', 'web_search'] }, inner: 3 },
				'7': { type: 'object', meta: {}, dict: { userTools: 5, blockedTools: 3 } },
			},
		};
		expect(readToolOptions(envelope, 'userTools')).toEqual(['bash', 'web_search']);
		expect(readToolOptions(envelope, 'blockedTools')).toBeUndefined();
	});

	it('形状不符时一律返回 undefined（旧宿主/内存模式回退）', () => {
		expect(readToolOptions(undefined, 'userTools')).toBeUndefined();
		expect(readToolOptions(null, 'userTools')).toBeUndefined();
		expect(readToolOptions('nope', 'userTools')).toBeUndefined();
		expect(readToolOptions({ uid: 'x', refs: {} }, 'userTools')).toBeUndefined();
		expect(readToolOptions({ uid: 1, refs: null }, 'userTools')).toBeUndefined();
		expect(readToolOptions({ uid: 1, refs: { '1': { type: 'object' } } }, 'userTools')).toBeUndefined();
		expect(readToolOptions({ uid: 1, refs: { '1': { type: 'object', dict: {} } } }, 'userTools')).toBeUndefined();
		expect(readToolOptions({ uid: 1, refs: { '1': { type: 'object', dict: { userTools: 9 } } } }, 'userTools')).toBeUndefined();
		expect(readToolOptions({ uid: 1, refs: { '1': { type: 'object', dict: { userTools: 2 } }, '2': { type: 'array' } } }, 'userTools')).toBeUndefined();
		expect(
			readToolOptions({ uid: 1, refs: { '1': { type: 'object', dict: { userTools: 2 } }, '2': { type: 'array', meta: { [TOOL_OPTIONS_META_KEY]: 'bash' } } } }, 'userTools'),
		).toBeUndefined();
		expect(
			readToolOptions({ uid: 1, refs: { '1': { type: 'object', dict: { userTools: 2 } }, '2': { type: 'array', meta: { [TOOL_OPTIONS_META_KEY]: [1, '', 'ok'] } } } }, 'userTools'),
		).toEqual(['ok']);
	});
});

describe('attachToolOptions ↔ readToolOptions（宿主写入 → describe 上行 → 浏览器读取）', () => {
	it('真实 schemastery schema 序列化回环', () => {
		expect(readToolOptions(ConfigSchema.toJSON(), 'userTools')).toBeUndefined();
		attachToolOptions(['web_search', 'bash', 'qq_send', 'bash']);
		const options = readToolOptions(ConfigSchema.toJSON(), 'userTools');
		expect(options).toEqual(['bash', 'qq_send', 'web_search']);
		expect(readToolOptions(ConfigSchema.toJSON(), 'blockedTools')).toEqual(['bash', 'qq_send', 'web_search']);
		// schema 仍是活的：后续 tools/change 再附加会覆盖旧清单。
		attachToolOptions(['bash']);
		expect(readToolOptions(ConfigSchema.toJSON(), 'userTools')).toEqual(['bash']);
		// 其他字段不受影响。
		expect((ConfigSchema as unknown as { dict: Record<string, { meta?: Record<string, unknown> }> }).dict.url?.meta?.[TOOL_OPTIONS_META_KEY]).toBeUndefined();
	});
});
