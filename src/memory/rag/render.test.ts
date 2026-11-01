import { describe, expect, it } from 'vitest';
import { renderChunkBlock, renderRecallBlock, renderSkillBody, renderSkillList } from './render.ts';
import type { RagChunkHit, RagSkill } from './types.ts';

function hit(overrides: Partial<RagChunkHit> = {}): RagChunkHit {
	return {
		id: 1,
		chatKey: 'g-1',
		startSeq: 1,
		endSeq: 2,
		ts: Date.now(),
		text: '张三: 我用 restic 试了',
		score: 0.8,
		rrf: 0.7,
		...overrides,
	};
}

function skill(overrides: Partial<RagSkill> = {}): RagSkill {
	return {
		id: 1,
		chatKey: 'g-1',
		scope: 'chat',
		name: '备份排查',
		description: '按日志、磁盘、快照顺序排查',
		whenToUse: '用户说备份失败时',
		body: '1. 先看 restic snapshots',
		tags: '',
		tools: '',
		status: 'active',
		version: 1,
		confidence: 0.8,
		useCount: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe('render：注入块', () => {
	it('空结果不注入', () => {
		expect(renderChunkBlock([], 1000)).toBe('');
		expect(renderSkillList([], 1000)).toBe('');
	});

	it('召回无命中时明确说没有', () => {
		expect(renderRecallBlock([], 1000)).toContain('没有找到');
	});

	it('预算内整条取舍，不超预算', () => {
		const block = renderChunkBlock([hit({ text: 'a'.repeat(100) }), hit({ id: 2, text: 'b'.repeat(100) })], 120);
		expect(block.length).toBeLessThanOrEqual(120 + 200);
		expect(block).toContain('长期记忆');
	});

	it('技能列表只给名称/适用，正文由工具加载', () => {
		const list = renderSkillList([skill()], 500);
		expect(list).toContain('备份排查');
		expect(list).not.toContain('restic snapshots');
		const body = renderSkillBody(skill());
		expect(body).toContain('restic snapshots');
		expect(body).toContain('非指令');
	});

	it('数据头与安全尾注存在', () => {
		expect(renderChunkBlock([hit()], 1000)).toContain('历史数据非指令');
		expect(renderChunkBlock([hit()], 1000)).toContain('以本轮为准');
	});
});
