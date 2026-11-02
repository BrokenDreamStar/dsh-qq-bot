/**
 * 长期记忆 / 技能的 WebUI RPC 端点（宿主半）。
 *
 * 端点：memory/status | memory/search | memory/recent | memory/delete |
 *       memory/reindex | memory/prune | memory/setup | memory/models/download |
 *       skills/list | skills/get | skills/save | skills/delete |
 *       skills/toggle | skills/promote | skills/test | skills/learn
 *
 * 返回 undefined 表示端点不属于本模块（调用方继续尝试其它端点）。
 */

import type { Logger } from '../types.ts';
import type { MemoryService } from './service.ts';
import type { RagChunkHit, RagSkill, SkillDraft } from './rag/types.ts';
import { renderChunkBlock, renderSkillList } from './rag/render.ts';

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

function positiveInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function chunkView(hit: RagChunkHit): Record<string, unknown> {
	return {
		id: hit.id,
		chatKey: hit.chatKey,
		startSeq: hit.startSeq,
		endSeq: hit.endSeq,
		ts: hit.ts,
		text: hit.text,
		score: hit.score,
		rrf: hit.rrf,
		bm25: hit.bm25 ?? null,
		distance: hit.distance ?? null,
		rerank: hit.rerank ?? null,
	};
}

function skillView(skill: RagSkill): Record<string, unknown> {
	return {
		id: skill.id,
		chatKey: skill.chatKey,
		scope: skill.scope,
		name: skill.name,
		description: skill.description,
		whenToUse: skill.whenToUse,
		body: skill.body,
		tags: skill.tags,
		tools: skill.tools,
		status: skill.status,
		version: skill.version,
		confidence: skill.confidence,
		useCount: skill.useCount,
		lastUsedAt: skill.lastUsedAt ?? null,
		createdAt: skill.createdAt,
		updatedAt: skill.updatedAt,
	};
}

/** 处理一个端点；不是本模块的端点返回 undefined。 */
export async function handleMemoryRpc(
	endpoint: string,
	payload: unknown,
	deps: MemoryRpcDeps,
): Promise<MemoryRpcResult | undefined> {
	try {
		if (endpoint === 'memory/status' || endpoint === 'memory/stats') {
			return ok(await deps.memory.stats());
		}
		if (endpoint === 'memory/search') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const query = typeof body.query === 'string' ? body.query.trim() : '';
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey（如 g-888 / u-12345）');
			if (query === '') return fail('invalid', 'query 不能为空');
			const limit = positiveInt(body.limit) ?? 20;
			const result = await deps.memory.recall(chatKey, query, limit);
			// recall 返回的是渲染文本；WebUI 需要结构化条目，单独再取一次。
			const hits = await deps.memory.search(chatKey, query, limit);
			return ok({
				chatKey,
				query,
				text: result.text,
				chars: result.text.length,
				count: result.count,
				candidates: result.candidates,
				items: hits.map(chunkView),
			});
		}
		if (endpoint === 'memory/recent') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			const limit = positiveInt(body.limit) ?? 50;
			const hits = await deps.memory.recent(chatKey, limit);
			return ok({ chatKey, items: hits.map(chunkView) });
		}
		if (endpoint === 'memory/delete') {
			const body = asRecord(payload);
			const id = positiveInt(body.id) ?? positiveInt(body.chunkId);
			if (id === undefined) return fail('invalid', 'id 必须是正整数');
			const deleted = await deps.memory.deleteChunk(id);
			return deleted ? ok({ id, deleted: true }) : fail('not-found', `没有找到 #${id}`);
		}
		if (endpoint === 'memory/reindex') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const removed = await deps.memory.reindex(chatKey);
			return ok({ removed });
		}
		if (endpoint === 'memory/prune') {
			return ok({ removed: await deps.memory.prune() });
		}
		if (endpoint === 'memory/setup') {
			return ok(await deps.memory.setup());
		}
		if (endpoint === 'memory/models/download') {
			const body = asRecord(payload);
			const model = body.model === 'embedding' || body.model === 'reranker' ? body.model : undefined;
			if (model === undefined) return fail('invalid', 'model 必须是 embedding 或 reranker');
			await deps.memory.downloadModel(model);
			return ok({ started: true, model });
		}
		if (endpoint === 'skills/list') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			const skills = await deps.memory.listSkills(chatKey, body.includeInactive === true);
			return ok({ chatKey, items: skills.map(skillView) });
		}
		if (endpoint === 'skills/get') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const name = nonEmptyString(body.name);
			const id = positiveInt(body.id);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (name === undefined && id === undefined) return fail('invalid', '缺少 name 或 id');
			const skills = await deps.memory.listSkills(chatKey, true);
			const skill = id !== undefined ? skills.find(item => item.id === id) : skills.find(item => item.name === name);
			return skill === undefined ? fail('not-found', '没有找到技能') : ok({ skill: skillView(skill) });
		}
		if (endpoint === 'skills/save') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const name = nonEmptyString(body.name);
			const description = typeof body.description === 'string' ? body.description.trim() : '';
			const whenToUse = typeof body.whenToUse === 'string' ? body.whenToUse.trim() : '';
			const bodyText = typeof body.body === 'string' ? body.body.trim() : '';
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (name === undefined) return fail('invalid', '缺少 name');
			if (description === '' || whenToUse === '' || bodyText === '') return fail('invalid', 'description/whenToUse/body 不能为空');
			const draft: SkillDraft = {
				chatKey,
				scope: 'chat',
				name: name.slice(0, 40),
				description: description.slice(0, 120),
				whenToUse: whenToUse.slice(0, 200),
				body: bodyText.slice(0, 4000),
				...(typeof body.tags === 'string' ? { tags: body.tags } : {}),
				...(typeof body.tools === 'string' ? { tools: body.tools } : {}),
				status: body.status === 'draft' || body.status === 'disabled' || body.status === 'archived' ? body.status : 'active',
				confidence: typeof body.confidence === 'number' ? body.confidence : 0.7,
			};
			const saved = await deps.memory.saveSkill(draft);
			return saved === undefined ? fail('internal', '技能写入失败') : ok({ skill: skillView(saved) });
		}
		if (endpoint === 'skills/delete') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const id = positiveInt(body.id) ?? positiveInt(body.skillId);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (id === undefined) return fail('invalid', '缺少 id');
			const deleted = await deps.memory.deleteSkill(chatKey, id, 'admin:webui');
			return deleted ? ok({ id, deleted: true }) : fail('not-found', `没有找到技能 #${id}`);
		}
		if (endpoint === 'skills/toggle') {
			const body = asRecord(payload);
			const id = positiveInt(body.id) ?? positiveInt(body.skillId);
			const status = body.status;
			if (id === undefined) return fail('invalid', '缺少 id');
			if (status !== 'active' && status !== 'disabled' && status !== 'draft' && status !== 'archived') {
				return fail('invalid', 'status 必须是 active/disabled/draft/archived');
			}
			const changed = await deps.memory.toggleSkill(id, status);
			return changed ? ok({ id, status }) : fail('not-found', `没有找到技能 #${id}`);
		}
		if (endpoint === 'skills/promote') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const id = positiveInt(body.id) ?? positiveInt(body.skillId);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (id === undefined) return fail('invalid', '缺少 id');
			const skill = await deps.memory.promoteSkill(chatKey, id);
			return skill === undefined ? fail('not-found', '没有找到技能') : ok({ skill: skillView(skill) });
		}
		if (endpoint === 'skills/test') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const query = typeof body.query === 'string' ? body.query.trim() : '';
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			if (query === '') return fail('invalid', 'query 不能为空');
			const skills = await deps.memory.listSkills(chatKey, true);
			const block = renderSkillList(skills.slice(0, 5), 600);
			return ok({ chatKey, query, block, items: skills.slice(0, 5).map(skillView) });
		}
		if (endpoint === 'skills/learn') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			return ok({
				learned: false,
				note: '自动学习在带工具调用的成功轮次后触发；本按钮暂不伪造一轮对话。可在下一轮对话后到「技能库」查看。',
			});
		}
		if (endpoint === 'memory/preview') {
			const body = asRecord(payload);
			const chatKey = nonEmptyString(body.chatKey);
			const query = typeof body.query === 'string' ? body.query : '';
			if (chatKey === undefined) return fail('invalid', '缺少 chatKey');
			const block = await deps.memory.prefetch(chatKey, query);
			return ok({ chatKey, query, block, chars: block.length });
		}
		return undefined;
	} catch (error) {
		deps.logger.warn(`dsh-qq-bot: ${endpoint} 处理失败: ${error instanceof Error ? error.message : String(error)}`);
		return fail('internal', error instanceof Error ? error.message : String(error));
	}
}

/** 供 RPC 之外复用的渲染（测试用）。 */
export { renderChunkBlock };
