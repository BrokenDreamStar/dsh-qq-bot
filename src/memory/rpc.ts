/**
 * 长期记忆的 WebUI RPC 端点（宿主半）。
 *
 * 「记忆库与技能」管理卡已按用户要求删除，内容维护走 QQ 里的 `/memory`
 * 命令（status / search / recent / forget / reindex / prune / setup）。
 * 这里只剩「长期记忆」卡仍在用的两个端点：
 *
 *   memory/status  卡片内的运行时与本地模型状态（1.5s 轮询）
 *   memory/setup   卡片里的「安装运行时」按钮
 *
 * 返回 undefined 表示端点不属于本模块（调用方继续尝试其它端点）。
 */

import type { Logger } from '../types.ts';
import type { MemoryService } from './service.ts';

export type MemoryRpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

export interface MemoryRpcDeps {
	memory: MemoryService;
	logger: Logger;
}

const ok = (value: unknown): MemoryRpcResult => ({ ok: true, value });
const fail = (code: string, message: string): MemoryRpcResult => ({ ok: false, error: { code, message } });

/** 处理一个端点；不是本模块的端点返回 undefined。 */
export async function handleMemoryRpc(
	endpoint: string,
	_payload: unknown,
	deps: MemoryRpcDeps,
): Promise<MemoryRpcResult | undefined> {
	try {
		if (endpoint === 'memory/status') {
			return ok(await deps.memory.stats());
		}
		if (endpoint === 'memory/setup') {
			return ok(await deps.memory.setup());
		}
		return undefined;
	} catch (error) {
		deps.logger.warn(`dsh-qq-bot: ${endpoint} 处理失败: ${error instanceof Error ? error.message : String(error)}`);
		return fail('internal', error instanceof Error ? error.message : String(error));
	}
}
