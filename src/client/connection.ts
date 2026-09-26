/**
 * 连接卡片头部的"已连接"状态指示（纯逻辑，不依赖 react，可测）。
 *
 * 宿主 /dsh-qq-bot RPC 通道的 `status/connection` 端点返回
 * `{ connected: boolean }`（transport 的实时状态）。这里只负责"取一次"与
 * "读应答"；轮询节奏与角标渲染由 components.tsx 持有。
 *
 * 任何异常（宿主没有 RPC / 通道没注册 / 网络抖动）一律视为未连接：
 * 角标是"已连接"的提示，宁可不显示也不要误报。
 */
import type { RpcCaller } from './types.ts';

/** 宿主端注册在 /dsh-qq-bot 通道上的连接状态端点。 */
export const CONNECTION_STATUS_ENDPOINT = 'status/connection';

/** 约束式读取应答（跨版本字段变动时不误报已连接）。 */
export function readConnected(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	return (value as { connected?: unknown }).connected === true;
}

/** 拉一次连接状态；失败/异常 = 未连接。 */
export async function fetchTransportConnected(call: RpcCaller): Promise<boolean> {
	try {
		const result = await call(CONNECTION_STATUS_ENDPOINT);
		return result.ok && readConnected(result.value);
	} catch {
		return false;
	}
}
