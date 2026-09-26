/**
 * Agent 轮次驱动：followup → whenIdle → 汇总最后一轮 assistant 文本。
 * 与 headless 模式一致；超时用 agent.cancel({kind:'hook'}) 中断并落稳。
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from '../dsh.ts';
import type { SessionStore } from '../dsh.ts';

export interface TurnOutcome {
	/** 最后一轮 assistant 文本（可能为空）。 */
	text: string;
	endReason?: TurnEndReason;
	timedOut: boolean;
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
export function summarizeTurn(events: readonly SessionEvent[], firstSeq: number): { text: string; endReason?: TurnEndReason } {
	let started = false;
	let text = '';
	let endReason: TurnEndReason | undefined;
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
		if (event.type === 'turn/end') endReason = event.data.reason;
	}
	return { text, endReason };
}

export async function runTurn(options: {
	agent: Agent;
	sessions: SessionStore;
	/** 进入 agent 的用户文本（已含发送者上下文与媒体路径）。 */
	promptText: string;
	maxTurnMs: number;
}): Promise<TurnOutcome> {
	const { agent, sessions, promptText, maxTurnMs } = options;
	const firstSeq = agent.session.seq;
	agent.followup(
		createUserMessage({
			content: [{ type: 'text', text: promptText }],
			source: { kind: 'user' },
		}),
	);

	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			resolve();
		}, maxTurnMs);
	});
	try {
		await Promise.race([agent.whenIdle(), guard]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}

	if (timedOut) {
		agent.cancel({ kind: 'hook', reason: 'dsh-qq-bot turn timeout' });
		// 等取消落稳，避免后续消息排在旧驱动后面。
		await agent.whenIdle().catch(() => {});
	}

	try {
		await sessions.flush(agent.session);
	} catch {
		// 落盘失败不阻断回复（下次 flush 会补）。
	}
	const { text, endReason } = summarizeTurn(readSessionEvents(agent.session), firstSeq);
	return { text, endReason, timedOut };
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
