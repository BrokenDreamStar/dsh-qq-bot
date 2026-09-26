/**
 * WebUI 配置热应用（纯逻辑，便于测试）。
 *
 * dsh 的 settings 服务在配置变更后不会重启插件，只回调 setSource/onChange。
 * 各服务都在调用时实时读 config 字段，所以把解析后的最新配置原地合并进
 * 运行中的 config 对象即可生效；唯一例外是需要重建 transport 的连接参数
 * 与构造时快照的 RateLimiter 参数，由调用方按返回值/深比较单独处理。
 *
 * 路径迁移（旧 `workspaceRoot` / `sessionGroupRoot` / `adminUsersFile` → 统一的
 * `dataDir`）不在这里：计划与执行见 `paths.ts`，由 `index.ts` 在 apply 开头与
 * settings hooks 里各调用一次。
 */
import type { DshQQConfig } from './config.ts';

/** 传输层构造参数涉及的配置字段：这些字段变化需要重建 transport。 */
export const TRANSPORT_FIELDS = [
	'transport',
	'url',
	'reversePort',
	'reversePath',
	'accessToken',
	'reconnectDelayMs',
] as const;

/** transport 可重建性签名（仅由连接参数构成）。 */
export function transportSignature(config: DshQQConfig): string {
	return TRANSPORT_FIELDS.map((field) => String(config[field])).join('\u0000');
}

/**
 * rateLimit 签名（Dispatcher 的 RateLimiter 构造时快照这两个值）。
 */
export function rateLimitSignature(rate: DshQQConfig['rateLimit']): string {
	return `${rate.windowMs}\u0000${rate.max}`;
}

/**
 * 把 settings 解析出的最新配置原地合并进运行中的 config 对象。
 * @returns 是否需要重建 transport（连接参数发生变化）。
 */
export function hotApplyConfig(target: DshQQConfig, resolved: DshQQConfig): boolean {
	const before = transportSignature(target);
	Object.assign(target, resolved);
	return transportSignature(target) !== before;
}
