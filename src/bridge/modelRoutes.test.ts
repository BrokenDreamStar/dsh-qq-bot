import { describe, expect, it } from 'vitest';
import { describeModelSource, formatModelSpec, parseModelSpec, resolveChatModel } from './modelRoutes.ts';

describe('parseModelSpec / formatModelSpec', () => {
	it('provider/model 拆分，模型名里的 / 保留', () => {
		expect(parseModelSpec('deepseek/deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
		expect(parseModelSpec('openrouter/anthropic/claude-3')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-3' });
	});

	it('只有模型名时不带 provider', () => {
		expect(parseModelSpec('deepseek-chat')).toEqual({ model: 'deepseek-chat' });
	});

	it('空串与残缺的 provider/ 或 /model 视为非法', () => {
		expect(parseModelSpec('')).toBeNull();
		expect(parseModelSpec('   ')).toBeNull();
		expect(parseModelSpec('deepseek/')).toBeNull();
		expect(parseModelSpec('/deepseek-chat')).toBeNull();
	});

	it('格式化：缺 model 返回空串（= 用部署默认）', () => {
		expect(formatModelSpec({ provider: 'deepseek', model: 'deepseek-chat' })).toBe('deepseek/deepseek-chat');
		expect(formatModelSpec({ model: 'deepseek-chat' })).toBe('deepseek-chat');
		expect(formatModelSpec({ provider: 'deepseek' })).toBe('');
		expect(formatModelSpec({})).toBe('');
	});
});

describe('resolveChatModel（会话/WebUI 配置 > 部署默认）', () => {
	it('有覆盖时用覆盖，来源标记为会话配置', () => {
		const resolved = resolveChatModel({ override: 'override/model' });
		expect(resolved.model).toEqual({ provider: 'override', model: 'model' });
		expect(resolved.source).toEqual({ kind: 'chatOverride' });
	});

	it('空覆盖/非法覆盖视为无覆盖', () => {
		expect(resolveChatModel({ override: '' }).source).toEqual({ kind: 'default' });
		expect(resolveChatModel({ override: 'broken/' }).source).toEqual({ kind: 'default' });
	});

	it('无号码行时用「默认会话」行，号码行仍然优先', () => {
		const fallback = resolveChatModel({ configDefault: 'config/model' });
		expect(fallback.model).toEqual({ provider: 'config', model: 'model' });
		expect(fallback.source).toEqual({ kind: 'configDefault' });
		const override = resolveChatModel({ override: 'override/model', configDefault: 'config/model' });
		expect(override.model).toEqual({ provider: 'override', model: 'model' });
		expect(override.source).toEqual({ kind: 'chatOverride' });
		// 默认行残缺/为空时回落部署默认。
		expect(resolveChatModel({ configDefault: 'broken/' }).source).toEqual({ kind: 'default' });
		expect(resolveChatModel({ configDefault: '' }).source).toEqual({ kind: 'default' });
	});

	it('未配置时回落到部署默认', () => {
		const resolved = resolveChatModel({});
		expect(resolved.model).toBeUndefined();
		expect(resolved.source).toEqual({ kind: 'default' });
	});
});

describe('describeModelSource', () => {
	it('描述各来源', () => {
		expect(describeModelSource({ kind: 'chatOverride' })).toContain('/model');
		expect(describeModelSource({ kind: 'chatOverride' })).toContain('WebUI');
		expect(describeModelSource({ kind: 'configDefault' })).toContain('默认会话行');
		expect(describeModelSource({ kind: 'default' })).toBe('dsh 部署默认');
	});
});
