import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.ts';
import { isVolatileRef, unwrapVolatileConfig } from './volatileConfig.ts';

const WRITE = Symbol.for('cosmokit.volatile.write');

/** 造一个与 schemastery/cosmokit 形状一致的 volatile 引用。 */
function ref<T>(value: T): { get(): T; [WRITE]: (next: T) => void } {
	let current = value;
	return {
		get: () => current,
		[WRITE]: (next: T) => {
			current = next;
		},
	};
}

describe('isVolatileRef', () => {
	it('只认带 get 与 cosmokit 写入符号的对象', () => {
		expect(isVolatileRef(ref(1))).toBe(true);
		expect(isVolatileRef({ get: () => 1 })).toBe(false);
		expect(isVolatileRef({ [WRITE]: () => {} })).toBe(false);
		expect(isVolatileRef(null)).toBe(false);
		expect(isVolatileRef('x')).toBe(false);
		expect(isVolatileRef([])).toBe(false);
	});
});

describe('unwrapVolatileConfig', () => {
	it('解开根引用与嵌套引用', () => {
		const source = ref({
			transport: 'reverse',
			rateLimit: ref({ windowMs: 60000, max: 30 }),
			allowedUsers: ref(['1', '2']),
		});
		expect(unwrapVolatileConfig(source)).toEqual({
			transport: 'reverse',
			rateLimit: { windowMs: 60000, max: 30 },
			allowedUsers: ['1', '2'],
		});
	});

	it('普通对象/数组原样复制，非普通对象保持不变', () => {
		const date = new Date(0);
		const input = { list: [1, { nested: true }], date };
		const output = unwrapVolatileConfig(input);
		expect(output).toEqual(input);
		expect(output).not.toBe(input);
		expect(output.date).toBe(date);
	});

	it('引用内容变化后能读到新值', () => {
		const source = ref({ replyMaxChars: 4500 });
		expect(unwrapVolatileConfig(source).replyMaxChars).toBe(4500);
		source[WRITE]({ replyMaxChars: 4600 });
		expect(unwrapVolatileConfig(source).replyMaxChars).toBe(4600);
	});
});

describe('ConfigSchema 必须是 volatile 根节点', () => {
	it('settings 0.2.1 只暴露 volatile 字段；根节点丢掉 volatile 会让配置页整体消失', () => {
		expect(ConfigSchema.meta?.volatile).toBe(true);
	});
});
