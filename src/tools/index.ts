/**
 * 模型可见工具：主动消息三件套。
 *
 *  - qq_send       向当前对话的 QQ 会话发文本（进度汇报/主动提问）
 *  - qq_send_image 向当前对话发图片（agent 工作目录内的文件或 http(s) URL）
 *  - qq_recall     撤回机器人刚发出的消息
 *
 * 聊天记录读取（qq_read_history）在 tools/history.ts，定时任务在
 * tools/tasks.ts；三者共用下面的 requireBridge。
 *
 * 工具全局注册；非 QQ 会话调用会得到明确报错。通过
 * agents.currentInitiator() 找到正在执行工具的 agent，再按会话 id
 * 反查所属桥。
 */
import { resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { DshServices } from '../dsh.ts';
import type { DshQQConfig } from '../config.ts';
import type { ChatBridge, ChatBridgeManager } from '../bridge/chat.ts';

interface ToolRegistryLike {
	register(definition: unknown): void;
}

/** 正在执行工具的 agent 所属的 QQ 会话桥；非 QQ 会话抛错。 */
export function requireBridge(services: DshServices, manager: ChatBridgeManager): ChatBridge {
	const agent = services.agents.currentInitiator();
	if (agent === undefined) throw new Error('dsh-qq-bot: 当前没有正在运行的 agent');
	const bridge = manager.bridgeBySessionId(String(agent.session.id));
	if (bridge === undefined) throw new Error('dsh-qq-bot: 当前会话未绑定 QQ 聊天（该工具仅 QQ 会话可用）');
	return bridge;
}

/**
 * 校验图片路径在允许的目录内：会话目录（`<root>/Friend_|Group_号`，媒体
 * 落盘处与默认工作目录）或 agent 的当前工作目录（/cwd 切换后的项目目录、
 * 网关模式下的主目录）。
 */
export function resolveWorkspaceImage(bridge: { sessionDir: string; agentCwd: string }, path: string): string {
	const absolute = resolve(path);
	const roots = [...new Set([bridge.sessionDir, bridge.agentCwd])];
	const inside = roots.some((root) => absolute === root || absolute.startsWith(root.endsWith(sep) ? root : root + sep));
	if (!inside) {
		throw new Error(`dsh-qq-bot: 图片必须位于允许的目录内（${roots.join(' 或 ')}）`);
	}
	if (!existsSync(absolute)) throw new Error(`dsh-qq-bot: 文件不存在: ${absolute}`);
	if (!statSync(absolute).isFile()) throw new Error(`dsh-qq-bot: 不是文件: ${absolute}`);
	return absolute;
}

export function registerTools(ctx: Context, services: DshServices, manager: ChatBridgeManager, _config: DshQQConfig): void {
	const registry = (ctx as unknown as { tools?: ToolRegistryLike }).tools;
	if (registry === undefined) throw new Error('dsh-qq-bot: tools 服务不可用');

	registry.register(
		defineTool({
			name: 'qq_send',
			description:
				'Send a text message to the QQ conversation currently talking to this agent. Use it to proactively report progress, ask follow-up questions, or deliver results while working. Only available in dsh-qq-bot QQ sessions.',
			parameters: {
				text: { type: 'string', required: true, description: 'Message text to send.' },
			},
			output: {
				schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true } } },
				render: (_args, value) => [{ type: 'text', text: value.sent ? '已发送' : '发送失败' }],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const bridge = requireBridge(services, manager);
				await bridge.sendText(args.text);
				return { sent: true };
			},
		}),
	);

	registry.register(
		defineTool({
			name: 'qq_send_image',
			description:
				'Send an image to the QQ conversation currently talking to this agent. Provide a file path inside the agent working directory (incoming images land in the session media directory there), or an http(s) URL, plus an optional caption. Only available in dsh-qq-bot QQ sessions.',
			parameters: {
				path: { type: 'string', description: 'Image file path inside the agent working directory.' },
				url: { type: 'string', description: 'Image http(s) URL.' },
				caption: { type: 'string', description: 'Optional caption sent after the image.' },
			},
			output: {
				schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true } } },
				render: (_args, value) => [{ type: 'text', text: value.sent ? '已发送' : '发送失败' }],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const bridge = requireBridge(services, manager);
				if ((args.path === undefined) === (args.url === undefined)) {
					throw new Error('dsh-qq-bot: path 与 url 必须且只能提供一个');
				}
				const source =
					args.path !== undefined
						? { path: resolveWorkspaceImage(bridge, args.path) }
						: { url: args.url };
				const id = await bridge.sendImage(source, args.caption);
				return { sent: id !== null };
			},
		}),
	);

	registry.register(
		defineTool({
			name: 'qq_recall',
			description:
				'Recall (delete) a message previously sent by this bot in the current QQ conversation. Defaults to the most recent bot message. Only available in dsh-qq-bot QQ sessions.',
			parameters: {
				messageId: { type: 'integer', description: 'Message id to recall; defaults to the latest bot message.' },
			},
			output: {
				schema: { type: 'object', additionalProperties: false, properties: { recalled: { type: 'boolean', required: true } } },
				render: (_args, value) => [{ type: 'text', text: value.recalled ? '已撤回' : '撤回失败' }],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const bridge = requireBridge(services, manager);
				const messageId = args.messageId ?? bridge.lastSentId ?? undefined;
				if (messageId === undefined) throw new Error('dsh-qq-bot: 没有可撤回的机器人消息');
				const recalled = await bridge.recall(messageId);
				return { recalled };
			},
		}),
	);
}
