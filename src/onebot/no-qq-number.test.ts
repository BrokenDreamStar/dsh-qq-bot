/**
 * 回归护栏：**机器人在群里提人不输出 QQ 号**（用户明确要求）。
 *
 * 号码只会通过两类途径漏进回复：
 *  1. 渲染器把号码拼进"给模型看的文本"（发言人标签、@ 提及、成员列表、聊天记录、
 *     引用块、记忆检索行）——模型看到什么就会照抄什么；
 *  2. 运行时行为。
 *
 * 第 1 类类型系统拦不住：`${userId}` 拼进模板字符串完全合法。所以这里对
 * RENDERERS 里的源码做一次启发式扫描：**只拦截"表达式插值"**
 * （`${...identifier...}`，即 `${event.senderId}` / `${String(userId)}` 这种，
 * 而不是 `${groupId}.json` 这种内部标识符拼接），并配合下面的运行时断言。
 * 内部用途（缓存键、chatKey、文件路径）用裸标识符，所以不会被误报。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildQuotedBlock } from '../bridge/prompt.ts';
import { renderEventLine } from '../memory/rank.ts';
import { renderHandoff } from '../memory/handoff.ts';
import { renderTranscript } from './history.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 负责渲染"模型可见文本"的文件（号码禁止出现在其表达式插值里）。 */
const RENDERERS = [
	'roster.ts',
	'history.ts',
	join('..', 'bridge', 'prompt.ts'),
	join('..', 'memory', 'rank.ts'),
	join('..', 'memory', 'handoff.ts'),
] as const;

/**
 * 表达式插值：`${` 后不是裸标识符收尾（即真的把号码算进了字符串）。
 * 裸 `${userId}`（拼接内部键/路径）不算。
 */
const EXPRESSION_INTERPOLATION = /\$\{(?!\s*\w+\s*\})[^}]*\b(senderId|userId)\b[^}]*\}/;

/**
 * 内部上下文标记：出现这些之一说明该行不是在渲染给模型看的文本
 * （缓存键、chatKey、文件路径、比较/判空）。命中即跳过，避免误报。
 */
const INTERNAL_CONTEXT = /\b(join|pathFor|keyOf|dedupeKey|chatKeyFor|baseSessionIdFor)\s*\(|===|!==|\.has\(|\.get\(|\.set\(|\.slice\(/;

describe('模型可见文本不携带 QQ 号', () => {
	it.each(RENDERERS)('%s 的渲染里没有号码表达式插值', (file) => {
		const source = readFileSync(join(here, file), 'utf8');
		const hits = source
			.split('\n')
			.filter((line) => EXPRESSION_INTERPOLATION.test(line) && !INTERNAL_CONTEXT.test(line))
			.map((line) => line.trim());
		expect(hits, `${file} 把号码拼进了渲染文本：\n${hits.join('\n')}`).toEqual([]);
	});

	it('聊天工具与记忆的会话称呼不带群号/QQ 号', () => {
		// 调用点（不是渲染器）负责生成 chatLabel，所以这里扫调用点源码：
		// 模板里出现 chatId / groupId / chatKey 的切片即判定回归。
		const callSites = [join('..', 'tools', 'history.ts'), join('..', 'index.ts')] as const;
		for (const file of callSites) {
			const source = readFileSync(join(here, file), 'utf8');
			const labels = [...source.matchAll(/chatLabel:[^\n]*/g)].map((match) => match[0]);
			for (const label of labels) {
				expect(label, `${file} 的会话称呼带了号码：${label}`).not.toMatch(/chatId|groupId|chatKey/);
			}
		}
	});

	it('引用块只给昵称', () => {
		expect(buildQuotedBlock({ senderId: '2879767499', senderName: 'yanami', text: '在吗' })).toBe('[回复 yanami 的消息：在吗]');
	});

	it('聊天记录只给昵称，且 @ 提及不还原成号码', () => {
		const text = renderTranscript(
			[
				{
					chatType: 'group',
					chatId: '888',
					senderId: '2879767499',
					senderName: 'yanami',
					text: '@2413172694 你看呢',
					timeMs: Date.now(),
					self: false,
					seq: 1,
				},
			],
			{ chatLabel: '群 888 ', nameOf: (userId) => (userId === '2413172694' ? '雨泪' : undefined) },
		);
		expect(text).toContain('yanami：@雨泪 你看呢');
		expect(text).not.toMatch(/2879767499|2413172694/);
	});

	it('记忆档案行与交接尾巴只给昵称', () => {
		const event = {
			chatKey: 'g-888',
			generation: 'gen-1',
			ts: Date.now(),
			senderId: '2879767499',
			senderName: 'yanami',
			self: false,
			kind: 'chat' as const,
			text: '我用 restic 试了',
			seq: 1,
		};
		expect(renderEventLine(event)).not.toContain('2879767499');
		expect(renderHandoff({ tail: [event], lastActivityAt: Date.now() })).not.toContain('2879767499');
	});
});
