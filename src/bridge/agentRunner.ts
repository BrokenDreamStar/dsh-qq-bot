/**
 * Agent 轮次驱动：followup → whenIdle → 汇总最后一轮 assistant 文本。
 * 与 headless 模式一致。
 *
 * **没有"总时长超时"**（曾经的 `maxTurnMs` 已按用户要求删除：它会腰斩长任务）。
 * 兜底改由 {@link createStallGuard} 的**无进展看门狗**承担：只有连续一段时间
 * 会话事件流一动不动（真卡死）才中断，长任务只要有进展就跑多久都行。
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from '../dsh.ts';
import type { SessionStore } from '../dsh.ts';
import { createStallGuard } from './stall.ts';

export interface TurnOutcome {
	/** 最后一轮 assistant 文本（可能为空）。 */
	text: string;
	endReason?: TurnEndReason;
	/** 无进展看门狗判定卡死并中断了这一轮（见 stall.ts；不是总时长超时）。 */
	stalled: boolean;
	/** 本轮工具调用摘要（技能学习用；只给名称 + 脱敏参数预览）。 */
	toolCalls: Array<{ name: string; argsPreview?: string }>;
}

/**
 * 会话事件日志的读取面。
 *
 * dsh 0.1.2-alpha.4 起移除了 `Session.events` 访问器，改为按需物化的
 * `snapshotEvents()`（无参 = 完整日志快照，语义与旧访问器一致）。插件
 * 编译期依赖的旧版类型仍带 `events`，两版都要兼容，故按运行时形状探测。
 */
export interface SessionLogReader {
	snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[];
	events?: readonly SessionEvent[];
}

/** 读取会话事件日志（新版 snapshotEvents 优先，旧版 events 回退）。 */
export function readSessionEvents(session: SessionLogReader): readonly SessionEvent[] {
	if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
	if (session.events !== undefined) return session.events;
	throw new Error('dsh 会话 API 不兼容：Session 既没有 snapshotEvents() 也没有 events（请升级 dsh-qq-bot）');
}

/** 从事件流里取本轮最后一条 assistant 文本与结束原因。 */
export function summarizeTurn(
	events: readonly SessionEvent[],
	firstSeq: number,
): { text: string; endReason?: TurnEndReason; toolCalls: Array<{ name: string; argsPreview?: string }> } {
	let started = false;
	let text = '';
	let endReason: TurnEndReason | undefined;
	const toolCalls: Array<{ name: string; argsPreview?: string }> = [];
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === 'turn/start') {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === 'assistant/message') {
			const joined = event.data.message.content
				.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
				.map((block) => block.text)
				.join('');
			if (joined.trim() !== '') text = joined;
		}
		if (event.type === 'tool/call') {
			const data = event.data as { name?: unknown; arguments?: unknown };
			const name = typeof data.name === 'string' ? data.name : '';
			if (name !== '') toolCalls.push({ name, ...(previewArgs(data.arguments) !== undefined ? { argsPreview: previewArgs(data.arguments) } : {}) });
		}
		if (event.type === 'turn/end') endReason = event.data.reason;
	}
	return { text, endReason, toolCalls };
}

/** 工具参数预览：只取常见安全字段，命中密钥字样就隐藏。 */
function previewArgs(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || raw.trim() === '') return undefined;
	if (/(password|passwd|token|secret|api[_-]?key|private[_-]?key)/i.test(raw)) return '[已隐藏]';
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		for (const key of ['command', 'cmd', 'path', 'file', 'query', 'url', 'prompt', 'text']) {
			const value = parsed[key];
			if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 200);
		}
	} catch {
		// 不是 JSON：直接用原文
	}
	return raw.slice(0, 200);
}

export async function runTurn(options: {
	agent: Agent;
	sessions: SessionStore;
	/** 进入 agent 的用户文本（已含发送者上下文与媒体路径）。 */
	promptText: string;
	/**
	 * 无进展看门狗：连续这么久**没有任何会话事件**（且不在等用户回答）就中断本轮；
	 * 0/缺省 = 不监视。**不是总时长超时**——长任务只要有进展就不会被打断。
	 */
	idleTimeoutMs?: number;
	/** 是否正在等用户回答（豁免无进展计时）：传会话桥的 `asker.busy`。 */
	waitingForAnswer?: () => boolean;
}): Promise<TurnOutcome> {
	const { agent, sessions, promptText } = options;
	const firstSeq = agent.session.seq;
	agent.followup(
		createUserMessage({
			content: [{ type: 'text', text: promptText }],
			source: { kind: 'user' },
		}),
	);

	const guard = createStallGuard({
		idleMs: options.idleTimeoutMs ?? 0,
		// session.seq = "下一个事件的序号"（= 日志长度），每次事件追加都 +1：
		// 模型逐 chunk 输出、tool/call 与 tool/result、step 边界都算进展。
		progress: () => agent.session.seq,
		waiting: options.waitingForAnswer,
	});
	try {
		await Promise.race([agent.whenIdle(), guard.stalled]);
	} finally {
		guard.stop();
	}
	const stalled = guard.isStalled;
	if (stalled) {
		agent.cancel({ kind: 'hook', reason: 'dsh-qq-bot stall watchdog' });
		// 等取消落稳，避免后续消息排在旧驱动后面。
		await agent.whenIdle().catch(() => {});
	}

	try {
		await sessions.flush(agent.session);
	} catch {
		// 落盘失败不阻断回复（下次 flush 会补）。
	}
	const { text, endReason, toolCalls } = summarizeTurn(readSessionEvents(agent.session), firstSeq);
	return { text, endReason, stalled, toolCalls };
}

/** 汇总一个会话累计 token 用量（/stats 用）。 */
export function tokenUsage(agent: Agent): { input: number; output: number } {
	let input = 0;
	let output = 0;
	for (const event of readSessionEvents(agent.session)) {
		if (event.type !== 'assistant/message') continue;
		const usage = event.data.usage;
		if (usage === undefined) continue;
		input += usage.inputTokens ?? 0;
		output += usage.outputTokens ?? 0;
	}
	return { input, output };
}
