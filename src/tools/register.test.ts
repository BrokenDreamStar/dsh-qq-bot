/**
 * 工具注册冒烟测试：**真的调用 `defineTool`**（用仓库里那份 @deepseek-ai/dsh-tools
 * 编译一次工具定义）。
 *
 * 为什么必须有这组测试：`output.schema` 是 dsh-tools 的"值 schema DSL"，它
 * **不接受对象级 `required: [...]`**（只接受逐属性的 `required: true`）；写错会在
 * `defineTool` 里直接抛错，而 index.ts 的注册是被 try/catch 包着的——症状是
 * "插件能启动、日志里一行 warn、工具全都没有"，跑单测和构建都发现不了
 * （真实事故：qq_send / task_* / qq_read_history 曾因此全部注册失败）。
 */
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerTools } from './index.ts';
import { registerTaskTools } from './tasks.ts';
import { registerHistoryTool } from './history.ts';
import { registerSearchTool } from './search.ts';
import { registerMemoryTools } from './memory.ts';
import { TaskStore } from '../tasks/store.ts';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { DshQQConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** 捕获注册的假 tools 服务（不校验重复注册——那是 dsh 的事）。 */
function capture(): { ctx: Context; names: string[]; definitions: Array<Record<string, unknown>> } {
	const names: string[] = [];
	const definitions: Array<Record<string, unknown>> = [];
	const ctx = {
		tools: {
			// 真实 dsh 的 register 返回 disposer（`ctx.tools.register()` 的注销句柄）。
			register: (definition: unknown) => {
				const def = definition as Record<string, unknown> & { name?: string };
				if (typeof def.name === 'string') names.push(def.name);
				definitions.push(def);
				const name = String(def.name ?? '');
				return () => {
					const index = names.indexOf(name);
					if (index >= 0) names.splice(index, 1);
				};
			},
		},
	} as unknown as Context;
	return { ctx, names, definitions };
}

function fakeServices(): never {
	return { agents: { currentInitiator: () => undefined } } as unknown as never;
}

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-tools-'));

describe('工具注册（defineTool 真的能编译这些 schema）', () => {
	it('主动消息三件套', () => {
		const { ctx, names } = capture();
		registerTools(ctx, { agents: {} } as never, {} as never, {} as DshQQConfig);
		expect(names).toEqual(['qq_send', 'qq_send_image', 'qq_recall']);
	});

	it('定时任务三件套', () => {
		const { ctx, names } = capture();
		const store = new TaskStore(dataDir, logger);
		store.init();
		registerTaskTools(ctx, { agents: {} } as never, {} as never, store, { taskMaxPerChat: 20 } as DshQQConfig);
		expect(names).toEqual(['task_schedule', 'task_list', 'task_cancel']);
	});

	it('聊天记录读取', () => {
		const { ctx, names } = capture();
		registerHistoryTool(ctx, fakeServices(), {} as never, { enabled: true } as never, {} as DshQQConfig);
		expect(names).toEqual(['qq_read_history']);
	});

	it('网页搜索（含 timeoutMs 与必填字段）', () => {
		const { ctx, names, definitions } = capture();
		registerSearchTool(ctx, fakeServices(), {} as never, {} as never, {
			searchMaxQueries: 4,
			searchTimeoutMs: 20000,
		} as DshQQConfig);
		expect(names).toEqual(['qq_web_search']);
		const definition = definitions[0] as { timeoutMs?: number; output?: { schema?: { required?: string[] } } };
		// 工具级预算 = 单档超时 × 链上最多的三档 + 余量。
		expect(definition.timeoutMs).toBe(20000 * 3 + 5000);
		// 必填字段走逐属性 required（编译后才成为标准 JSON Schema 的 required 数组）。
		expect(definition.output?.schema?.required).toEqual(expect.arrayContaining(['sources', 'truncated', 'backends', 'unanswered']));
	});

	it('长期记忆两件套（recall / memorize）', () => {
		const { ctx, names, definitions } = capture();
		registerMemoryTools(ctx, fakeServices(), {} as never, { ready: true } as never, { memoryRecallEnabled: true } as never);
		expect(names).toEqual(['qq_recall_memory', 'qq_memorize']);
		// 必填字段同样走逐属性 required（对象级数组会让注册直接抛错）。
		const recall = definitions[0] as { output?: { schema?: { required?: string[] } } };
		expect(recall.output?.schema?.required).toEqual(expect.arrayContaining(['count', 'found', 'transcript']));
		const memorize = definitions[1] as { output?: { schema?: { required?: string[] } } };
		expect(memorize.output?.schema?.required).toEqual(expect.arrayContaining(['ok', 'message']));
	});

	it('长期记忆工具可以运行时摘除（关掉总开关时用）', () => {
		const { ctx, names } = capture();
		const dispose = registerMemoryTools(ctx, fakeServices(), {} as never, { ready: true } as never, { memoryRecallEnabled: true } as never);
		expect(names).toEqual(['qq_recall_memory', 'qq_memorize']);
		// 宿主返回 disposer 时必须能摘掉；返回 undefined = 老宿主，调用方据此记 warn。
		expect(typeof dispose).toBe('function');
		dispose?.();
		expect(names).toEqual([]);
		dispose?.(); // 幂等：重复调用不再报错
		expect(names).toEqual([]);
	});

	it('宿主不返回 disposer（老 dsh）时 registerMemoryTools 返回 undefined', () => {
		const names: string[] = [];
		const ctx = {
			tools: {
				register: (definition: unknown) => {
					names.push(String((definition as { name?: unknown }).name ?? ''));
				},
			},
		} as unknown as Context;
		const dispose = registerMemoryTools(ctx, fakeServices(), {} as never, { ready: true } as never, { memoryRecallEnabled: true } as never);
		expect(names).toEqual(['qq_recall_memory', 'qq_memorize']);
		expect(dispose).toBeUndefined();
	});

	it('值 schema 不接受对象级 required —— 这正是上面全部用逐属性 required 的原因', () => {
		expect(() =>
			defineTool({
				name: 'qq_schema_probe',
				description: 'probe',
				parameters: {},
				output: {
					schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean' } }, required: ['sent'] },
					render: () => [{ type: 'text', text: 'x' }],
				},
				isConcurrencySafe: () => true,
				async execute() {
					return { sent: true };
				},
			}),
		).toThrow(/required/u);
	});
});
