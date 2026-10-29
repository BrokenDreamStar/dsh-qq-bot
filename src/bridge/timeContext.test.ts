import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import * as timeContext from '@deepseek-ai/dsh-time-context';

/**
 * 真实调用 dsh 0.2.1-rc.2 的内置 time-context（不是仿造它的输出）。
 *
 * 这层测试保证 QQ 桥依赖的是宿主真实 API：`apply` 注册 pre-step 后会在
 * 模型可见历史里追加一条带来源、带时区与 ISO 时间戳的读数。QQ 请求没有
 * 浏览器时区，因此第三行会是 unavailable —— 这是宿主的既定策略，不是插件
 * 自己拼接时间。
 */
describe('dsh 内置 time-context', () => {
	it('pre-step 注入真实时间读数，且来源标记为 time-context', async () => {
		const state = { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null };
		let preStep: ((input: unknown, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{ kind: string; messages: Array<{ content: Array<{ text: string }>; source: { kind: string } }> }>) | undefined;
		const ctx = {
			sessionProjections: {
				register: vi.fn(),
				stateOf: () => state,
			},
			on: vi.fn((_event: string, listener: typeof preStep) => {
				preStep = listener;
			}),
		};
		timeContext.apply(ctx as unknown as Context, { refreshIntervalMs: 0 });
		expect(preStep).toBeTypeOf('function');

		const before = Date.now();
		const result = await preStep!(
			{
				agent: { session: { seq: 0, eventAt: () => undefined } },
				turn: 1,
				step: 1,
				signal: new AbortController().signal,
			},
			async () => ({ kind: 'continue', messages: [] }),
		);

		expect(result.kind).toBe('continue');
		expect(result.messages).toHaveLength(1);
		const message = result.messages[0]!;
		expect(message.source.kind).toBe('time-context');
		const text = message.content[0]!.text;
		expect(text).toMatch(/^Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\[[^\]]+\]/);
		expect(text).toContain('Browser time zone for this request: unavailable.');
		const stamp = text.split('\n')[0]!.replace(/^Time sampled while preparing turn 1, step 1: /, '').replace(/\[[^\]]+\]$/, '');
		expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before - 1_000);
	});
});
