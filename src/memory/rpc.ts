/**
 * 长期记忆的 WebUI RPC 端点（宿主半）。
 *
 * 数据面就是 `MemoryService` / `MemoryStore`；这里只做参数校验与视图映射。
 * 端点：memory/list | memory/save | memory/delete | memory/preview |
 *       memory/distill | memory/stats | memory/audit | memory/candidates。
 *
 * 返回 undefined 表示端点不属于本模块（调用方继续尝试其它端点）。
 */
import type { Logger } from '../types.ts';
import type { MemoryService } from './service.ts';
import type { MemoryFact, MemoryKind, MemoryStatus } from './types.ts';
import { MEMORY_KINDS, MEMORY_STATUSES } from './types.ts';

export type MemoryRpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

export interface MemoryRpcDeps {
	memory: MemoryService;
	logger: Logger;
}

const ok = (value: unknown): MemoryRpcResult => ({ ok: true, value });
const fail = (code: string, message: string): MemoryRpcResult => ({ ok: false, error: { code, message } });

function asRecord(payload: unknown): Record<string, unknown> {
	return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asStatus(value: unknown): MemoryStatus | 'all' | undefined {
	if (value === 'all') return 'all';
	return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value) ? (value as MemoryStatus) : undefined;
}

function asKind(value: unknown): MemoryKind | undefined {
	return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : undefined;
}

/** 条目 → 浏览器面（不要暴露内部字段）。 */
export function itemView(fact: MemoryFact): Record<string, unknown> {
	const content = fact.content ?? [fact.subject, fact.predicate, fact.object].filter((part) => part !== '').join(' ');
	return {
		id: fact.id,
		content,
		kind: fact.kind ?? 'fact',
		provenance: fact.provenance ?? 'agent',
		status: fact.status ?? 'active',
		importance: fact.importance ?? 0.5,
		confidence: fact.confidence,
		pinned: fact.pinned,
		createdAt: fact.createdAt,
		updatedAt: fact.updatedAt,
		expiresAt: fact.expiresAt ?? null,
		validFrom: fact.validFrom ?? null,
		validTo: fact.validTo ?? null,
	};
}

/**
 * 处理一个端点；不是本模块的端点返回 undefined。
 */
export async function handleMemoryRpc(
	endpoint: string,
	payload: unknown,
	deps: MemoryRpcDeps,
): Promise<MemoryRpcResult | undefined> {
	try {
		if (endpoint === 'memory/list' || endpoint === 'memory/candidates') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey（如 g-888 / u-12345）');
			const status = endpoint === 'memory/candidates' ? 'pending' : (asStatus(body.status) ?? 'active');
			const query = typeof body.query === 'string' ? body.query : undefined;
			const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.trunc(body.limit) : 100;
			const items = deps.memory.listItems(chatKey, { ...(query !== undefined ? { query } : {}), status, limit });
			return ok({
				chatKey,
				items: items.map(itemView),
				stats: deps.memory.stats(),
				chatStats: deps.memory.chatStats(chatKey),
				lastDistillError: deps.memory.lastDistillError?.(chatKey) ?? null,
				lastDistillNote: deps.memory.lastDistillNote?.(chatKey) ?? null,
			});
		}
		if (endpoint === 'memory/save') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const content = typeof body.content === 'string' ? body.content.trim() : '';
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (content === '') return fail('invalid', 'content 不能为空');
			const id = typeof body.id === 'number' && Number.isInteger(body.id) && body.id > 0 ? body.id : undefined;
			const result = deps.memory.saveItem(
				chatKey,
				{
					...(id !== undefined ? { id } : {}),
					content,
					...(asKind(body.kind) !== undefined ? { kind: asKind(body.kind) } : {}),
					...(typeof body.importance === 'number' && Number.isFinite(body.importance) ? { importance: body.importance } : {}),
					...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
					...(asStatus(body.status) !== undefined && asStatus(body.status) !== 'all' ? { status: asStatus(body.status) as MemoryStatus } : {}),
				},
				'admin:webui',
			);
			if (!result.ok) return fail('invalid', result.error);
			const items = deps.memory.listItems(chatKey, { status: 'all', limit: 200 });
			return ok({ chatKey, items: items.map(itemView), stats: deps.memory.stats() });
		}
		if (endpoint === 'memory/delete') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const id = typeof body.id === 'number' ? Math.trunc(body.id) : Number.NaN;
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (!Number.isInteger(id) || id <= 0) return fail('invalid', 'id 必须是正整数');
			const deleted = deps.memory.deleteItem(chatKey, id, 'admin:webui');
			return deleted ? ok({ id, deleted: true }) : fail('not-found', `没有找到 #${id}`);
		}
		if (endpoint === 'memory/preview') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const query = typeof body.query === 'string' ? body.query : '';
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			return ok(deps.memory.preview(chatKey, query));
		}
		if (endpoint === 'memory/distill') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			const changed = await deps.memory.distill(chatKey, { force: true });
			return ok({
				changed,
				error: deps.memory.lastDistillError?.(chatKey) ?? null,
				note: deps.memory.lastDistillNote?.(chatKey) ?? null,
			});
		}
		if (endpoint === 'memory/stats') {
			return ok(deps.memory.stats());
		}
		if (endpoint === 'memory/audit') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.trunc(body.limit) : 100;
			return ok({ chatKey, entries: deps.memory.auditLog(chatKey, limit) });
		}
		return undefined;
	} catch (error) {
		deps.logger.warn(`dsh-qq-bot: ${endpoint} 处理失败: ${error instanceof Error ? error.message : String(error)}`);
		return fail('internal', error instanceof Error ? error.message : String(error));
	}
}
