/**
 * dsh ≥ 0.2.1 的 live config 引用 → 普通配置对象。
 *
 * 0.2.1 起 settings 表单只暴露 schema 上标记 `.volatile()` 的字段，而这些字段
 * 在校验后是 `Volatile<T>`（`{ get(): T }`）引用：loader 直接更新引用内容来
 * 实现"不重启插件"的热应用，并派发 `loader/volatile-update`。
 *
 * 本插件内部大量代码直接读 `config.replyMaxChars` 这样的普通字段，所以在
 * `apply` 入口把引用解开成普通对象；热更新时再把最新引用解开并合并进同一个
 * 对象（服务持有的是这个对象的引用）。**不要**把 ref 直接传给业务层——那会
 * 让每个读取点都要写 `.get()`。
 */

/** cosmokit 的 volatile 引用写入符号名（跨包副本一致）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** cosmokit 的 volatile 引用（只依赖 get，不引包）。 */
export interface VolatileRef<T> {
	get(): T;
}

/** 判断一个值是不是 volatile 引用（duck-type，兼容 ESM/CJS 副本）。 */
export function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { get?: unknown }).get === 'function' &&
		VOLATILE_WRITE in value
	);
}

/**
 * 深度解开 volatile 引用。
 *
 * 只处理普通对象与数组（config 的值域就是 JSON 形），函数/类实例原样返回；
 * 循环引用不会被配置 schema 产出，这里不额外处理。
 */
export function unwrapVolatileConfig<T>(value: T): T {
	if (isVolatileRef(value)) return unwrapVolatileConfig(value.get() as T);
	if (Array.isArray(value)) return value.map((entry) => unwrapVolatileConfig(entry)) as T;
	if (value !== null && typeof value === 'object') {
		const prototype = Object.getPrototypeOf(value);
		if (prototype === Object.prototype || prototype === null) {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, unwrapVolatileConfig(child)]),
			) as T;
		}
	}
	return value;
}
