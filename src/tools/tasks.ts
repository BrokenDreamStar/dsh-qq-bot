/**
 * 模型可见工具：定时任务（未来任务）三件套。
 *
 *  - task_schedule 在当前会话创建定时任务（"每天9点叫我起床"这类话术落点）
 *  - task_list   列出当前会话的任务与下一次触发时间
 *  - task_cancel 取消（删除）当前会话的一个任务（支持 id 前缀匹配）
 *
 * 任务绑定发起会话（chatKey），到期由 TaskScheduler 触发、经会话桥把
 * agent 的执行结果主动发回该会话——模型无法指定任意发送目标。工具放行
 * 策略与 qq_send 一致（CHAT_TOOLS，能对话就能用），会话内滥用由
 * taskMaxPerChat 限制。
 *
 * 时间语义：模型的"现在"来自时间感知 section（宿主机真实时间）；
 * 工具只接受显式的本地时间字符串，时区换算是模型自己的责任。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { DshServices } from '../dsh.ts';
import type { DshQQConfig } from '../config.ts';
import type { ChatBridgeManager } from '../bridge/chat.ts';
import { nextRunAt, describeSchedule } from '../tasks/schedule.ts';
import { MAX_TASKS, validateTaskInput, type ScheduledTask, type TaskStore } from '../tasks/store.ts';

interface ToolRegistryLike {
	register(definition: unknown): void;
}

/** 在当前会话里解析任务 id：精确匹配优先，其次唯一前缀匹配。 */
function resolveChatTaskId(tasks: readonly ScheduledTask[], rawId: string): ScheduledTask | undefined {
	const id = rawId.trim();
	const exact = tasks.find((task) => task.id === id);
	if (exact !== undefined) return exact;
	const matches = tasks.filter((task) => task.id.startsWith(id));
	if (matches.length === 1) return matches[0];
	return undefined;
}

export function registerTaskTools(
	ctx: Context,
	services: DshServices,
	manager: ChatBridgeManager,
	store: TaskStore,
	config: DshQQConfig,
): void {
	const registry = (ctx as unknown as { tools?: ToolRegistryLike }).tools;
	if (registry === undefined) throw new Error('dsh-qq-bot: tools 服务不可用');

	registry.register(
		defineTool({
			name: 'task_schedule',
			description:
				'Create a scheduled task (future task) bound to the CURRENT QQ conversation. When it is due, you are re-invoked with `prompt` and your reply is proactively sent to this chat — use it whenever the user asks for things like "remind me at 9 every day", "wake me up at 7 on weekdays", or "in 20 minutes tell me ...". The current host time is provided in the system prompt; all times are host-local.',
			parameters: {
				prompt: {
					type: 'string',
					required: true,
					description: 'What to do when the task fires, written to your future self. Include enough context to act without this conversation.',
				},
				note: { type: 'string', description: 'Short label for the task list, e.g. 叫我起床.' },
				kind: {
					type: 'string',
					required: true,
					enum: ['once', 'daily', 'weekly'],
					description: "'once' fires at runAt; 'daily' fires every day at time; 'weekly' fires on weekdays at time.",
				},
				runAt: { type: 'string', description: "For kind=once: host-local date-time 'YYYY-MM-DD HH:mm'." },
				time: { type: 'string', description: "For kind=daily/weekly: 'HH:mm' (24h)." },
				weekdays: {
					type: 'array',
					items: { type: 'integer' },
					description: 'For kind=weekly: weekday numbers, 0=Sunday … 6=Saturday, e.g. [1,3,5].',
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string', required: true },
						schedule: { type: 'string', required: true },
						nextRunAt: { type: 'string' },
					},
				},
				render: (_args, value) => [
					{
						type: 'text',
						text: value.nextRunAt !== undefined ? `已创建定时任务（${value.schedule}），下次触发 ${value.nextRunAt}` : `已创建定时任务（${value.schedule}）`,
					},
				],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const agent = services.agents.currentInitiator();
				if (agent === undefined) throw new Error('dsh-qq-bot: 当前没有正在运行的 agent');
				const bridge = manager.bridgeBySessionId(String(agent.session.id));
				if (bridge === undefined) throw new Error('dsh-qq-bot: 当前会话未绑定 QQ 聊天（该工具仅 QQ 会话可用）');
				const validated = validateTaskInput({
					chatKey: bridge.key,
					chatType: bridge.scope,
					chatId: bridge.chatId,
					prompt: args.prompt,
					note: args.note,
					kind: args.kind,
					time: args.time,
					weekdays: args.weekdays,
					runAt: args.runAt,
				});
				if ('error' in validated) throw new Error(`dsh-qq-bot: ${validated.error}`);
				const added = store.add(
					{
						chatKey: validated.chatKey,
						chatType: validated.chatType,
						chatId: validated.chatId,
						prompt: validated.prompt,
						schedule: validated.schedule,
						note: validated.note,
						createdBy: bridge.turnSenderId || undefined,
					},
					{ total: MAX_TASKS, perChat: config.taskMaxPerChat },
				);
				if ('error' in added) throw new Error(`dsh-qq-bot: ${added.error}`);
				const next = nextRunAt(added.task.schedule, Date.now());
				return {
					id: added.task.id,
					schedule: describeSchedule(added.task.schedule),
					...(next !== null ? { nextRunAt: new Date(next).toISOString() } : {}),
				};
			},
		}),
	);

	registry.register(
		defineTool({
			name: 'task_list',
			description:
				'List the scheduled tasks of the CURRENT QQ conversation (id, label, prompt, schedule, next fire time). Use it to check what is already booked before creating or cancelling tasks.',
			parameters: {},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						tasks: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									id: { type: 'string', required: true },
									note: { type: 'string' },
									prompt: { type: 'string', required: true },
									schedule: { type: 'string', required: true },
									enabled: { type: 'boolean', required: true },
									nextRunAt: { type: 'string' },
								},
							},
						},
					},
				},
				render: (_args, value) => {
					const list = value.tasks ?? [];
					return [
						{
							type: 'text',
							text:
								list.length === 0
									? '当前会话没有定时任务'
									: list
											.map((task) => `${task.enabled ? '' : '（已停用）'}[${task.id}] ${task.schedule}${task.note !== '' ? ` · ${task.note}` : ''}${task.nextRunAt !== undefined ? ` · 下次 ${task.nextRunAt}` : ''}`)
											.join('\n'),
						},
					];
				},
			},
			isConcurrencySafe: () => true,
			async execute() {
				const agent = services.agents.currentInitiator();
				if (agent === undefined) throw new Error('dsh-qq-bot: 当前没有正在运行的 agent');
				const bridge = manager.bridgeBySessionId(String(agent.session.id));
				if (bridge === undefined) throw new Error('dsh-qq-bot: 当前会话未绑定 QQ 聊天（该工具仅 QQ 会话可用）');
				return {
					tasks: store.listByChat(bridge.key).map((task) => {
						const next = nextRunAt(task.schedule, Date.now());
						return {
							id: task.id,
							note: task.note ?? '',
							prompt: task.prompt,
							schedule: describeSchedule(task.schedule),
							enabled: task.enabled,
							...(next !== null ? { nextRunAt: new Date(next).toISOString() } : {}),
						};
					}),
				};
			},
		}),
	);

	registry.register(
		defineTool({
			name: 'task_cancel',
			description:
				'Cancel (delete) a scheduled task of the CURRENT QQ conversation. Pass the task id from task_list; a unique id prefix is accepted.',
			parameters: {
				id: { type: 'string', required: true, description: 'Task id (or unique prefix).' },
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: { cancelled: { type: 'boolean', required: true }, id: { type: 'string', required: true } },
				},
				render: (_args, value) => [{ type: 'text', text: value.cancelled ? `已取消定时任务 ${value.id}` : '取消失败' }],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const agent = services.agents.currentInitiator();
				if (agent === undefined) throw new Error('dsh-qq-bot: 当前没有正在运行的 agent');
				const bridge = manager.bridgeBySessionId(String(agent.session.id));
				if (bridge === undefined) throw new Error('dsh-qq-bot: 当前会话未绑定 QQ 聊天（该工具仅 QQ 会话可用）');
				const target = resolveChatTaskId(store.listByChat(bridge.key), args.id);
				if (target === undefined) throw new Error('dsh-qq-bot: 没有找到该任务（用 task_list 查看当前会话的任务 id）');
				store.remove(target.id);
				return { cancelled: true, id: target.id };
			},
		}),
	);
}
