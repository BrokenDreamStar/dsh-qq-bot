/**
 * 工具级权限守卫：普通用户仅能对话（+ 显式放行的工具），
 * 管理员才可以让 agent 操作电脑（Shell/文件等）。
 *
 * 三层决策（优先级从高到低）：
 *  1. blockedTools —— 全员禁用（含管理员），用于在 QQ 入口整体下线高危工具；
 *  2. 管理员 —— 放行全部（除 blockedTools）；
 *  3. 普通用户 —— 仅 userTools 白名单匹配的工具。
 *
 * 机器人自己的聊天工具（qq_send / qq_send_image / qq_recall / qq_read_history）
 * 与定时任务工具（task_schedule / task_list / task_cancel，绑定发起会话）是
 * 对话体验的一部分，永久放行：qq_read_history 只能读当前会话自己的记录，
 * 没有跨会话读取的入口。
 *
 * 守卫注册在 agent 作用域（setupAgent），通过 `tools/pre-execute`
 * 瀑布拦截：deny 时 reason 会作为工具错误反馈给模型，模型会向用户
 * 解释需要管理员权限，而不是静默失败或反复重试。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DshQQConfig } from '../config.ts';
import type { Logger } from '../types.ts';

/**
 * 聊天体验工具：任何能触发对话的用户都可用（定时任务绑定发起会话，同类放行）。
 *
 * ask_user_question 也在这里：它是"向正在对话的这个人提问"，提问由本插件转发到
 * QQ、回答也来自同一个人（见 bridge/asker.ts），因此普通用户可用；要整体下线就
 * 用 blockedTools。
 */
export const CHAT_TOOLS = ['qq_send', 'qq_send_image', 'qq_recall', 'qq_read_history', 'task_schedule', 'task_list', 'task_cancel', 'ask_user_question'];

/** 工具名匹配：精确名或尾部 `*` 前缀通配（`*` 单独出现 = 匹配全部）。 */
export function matchToolPattern(pattern: string, name: string): boolean {
	const trimmed = pattern.trim();
	if (trimmed === '*') return true;
	if (trimmed.endsWith('*')) return name.startsWith(trimmed.slice(0, -1));
	return trimmed === name;
}

export interface ToolPolicyDecision {
	allowed: boolean;
	/** deny 时给模型看的解释（要求模型转告用户）。 */
	reason?: string;
}

/** 纯函数决策（单测覆盖核心逻辑）。 */
export function decideTool(options: {
	name: string;
	isAdmin: boolean;
	userTools: string[];
	blockedTools: string[];
}): ToolPolicyDecision {
	const { name, isAdmin, userTools, blockedTools } = options;
	if (blockedTools.some((pattern) => matchToolPattern(pattern, name))) {
		return { allowed: false, reason: `工具 ${name} 已被 blockedTools 全局禁用（含管理员），谁都调不了。请直接告知用户，不要重试。` };
	}
	if (CHAT_TOOLS.includes(name)) return { allowed: true };
	if (isAdmin) return { allowed: true };
	if (userTools.some((pattern) => matchToolPattern(pattern, name))) return { allowed: true };
	return {
		allowed: false,
		reason: `权限不足：工具 ${name} 仅管理员可用。请告知用户，想用这个功能得让管理员来发起对话。`,
	};
}

interface ExecLike {
	name: string;
	agent?: { id?: unknown };
}

/**
 * 在 agent 作用域注册 pre-execute 守卫。
 *
 * @param agentCtx - agent 组装上下文（setupAgent 里拿到）
 * @param currentTurnIsAdmin - 返回当前这轮对话发起者是否管理员
 *   （桥按消息串行处理，轮次期间该值稳定）
 */
export function registerToolGuard(
	agentCtx: Context,
	currentTurnIsAdmin: () => boolean,
	config: DshQQConfig,
	logger: Logger,
): void {
	const listener = async (exec: ExecLike, next: () => Promise<unknown>): Promise<unknown> => {
		const decision = decideTool({
			name: exec.name,
			isAdmin: currentTurnIsAdmin(),
			userTools: config.restrictTools ? config.userTools : [],
			blockedTools: config.blockedTools,
		});
		if (decision.allowed) return next();
		logger.info(`dsh-qq-bot: 工具 ${exec.name} 被权限策略拦截`);
		return { kind: 'deny', reason: decision.reason ?? `工具 ${exec.name} 不可用` };
	};
	(ctxOn(agentCtx) as { on(event: string, listener: unknown): void }).on('tools/pre-execute', listener);
}

function ctxOn(ctx: Context): { on(event: string, listener: unknown): void } {
	return ctx as unknown as { on(event: string, listener: unknown): void };
}
