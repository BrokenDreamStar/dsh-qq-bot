/**
 * 提问中继：把 dsh user-questions 缝上的请求变成 QQ 上的问答（运行时状态机）。
 *
 * 流程（每个会话桥持有一个实例，见 bridge/chat.ts）：
 *   缝上的请求 → 逐题发到 QQ（`formatAskMessage`）→ 等用户回复
 *   → `parseAskAnswer` 解析 → 凑齐 `{ answers }` 返回给缝（`ask.ts` 里是纯逻辑）。
 *
 * 三个边界：
 *  - **等待有预算**（`askWaitBudget`，不超过单轮上限的一半）：超时就不再等，
 *    由调用方（ChatBridge.askFromQQ）决定是让给 dsh 界面还是给模型一个超时错误；
 *  - **取消立刻生效**：`request.signal` 中止（本轮超时/`/reset`/桥销毁）即返回
 *    `aborted`，绝不让工具调用挂在那里；
 *  - **一条都没发出去 = 不可投递**：transport 断开时 send 会返回 null，这时
 *    立刻返回 `undeliverable`，不去空等一个永远不会来的回复。
 *
 * 状态由 dispatcher 侧的 `acceptAnswer` 消费：命中时把消息文本投给正在等的那一题。
 */
import { splitText } from '../outbound/chunk.ts';
import type { MessageLogService } from '../logs/store.ts';
import type { ChatType, Logger } from '../types.ts';
import type { OBSegment } from '../onebot/segments.ts';
import { askWaitBudget, formatAskMessage, parseAskAnswer, toAnswerItem, type AskAnswer, type AskAnswerItem, type AskQuestion } from './ask.ts';

/** 中继结果：answer = 用户答完了；timeout = 预算内没答；aborted = 本轮被取消；undeliverable = 一条都没发出去。 */
export type RelayOutcome =
	| { kind: 'answer'; answer: AskAnswer }
	| { kind: 'timeout'; budgetMs: number }
	| { kind: 'aborted' }
	| { kind: 'undeliverable' };

/** 等待一题回答的结果。 */
type WaitOutcome = { kind: 'answer'; text: string } | { kind: 'aborted' } | { kind: 'timeout' };

/** 正在等待的一题（dispatcher 的应答判定与答案投递都读它）。 */
interface PendingQuestionState {
	question: AskQuestion;
	/** 题号（1 基）与总题数（文案里的进度）。 */
	index: number;
	total: number;
	/** 本轮的提问触发者（群聊里 @ 他与判定"他本人回答"用；未知为空串）。 */
	askerId: string;
	/** 本题发出的 QQ 消息 id（引用回复时据此认出"在回答本题"）。 */
	messageIds: number[];
	/** 本题的回答投递口（发送完成前为 undefined）。 */
	settle?: (outcome: WaitOutcome) => void;
}

export interface QuestionRelayDeps {
	/** 会话标签（日志用）。 */
	label: string;
	chatType: ChatType;
	chatId: string;
	/** 发一段 QQ 消息；返回 message_id（失败/断开为 null）。 */
	send(segments: OBSegment[]): Promise<number | null>;
	/** 实时读运行参数（等待上限与开关都是热应用的）。 */
	options(): { askUserWaitMs: number; maxTurnMs: number; replyMaxChars: number };
	/** 本轮的提问触发者（群聊应答判定与 @ 用）。 */
	askerId(): string;
	logger: Logger;
	logs?: MessageLogService;
	/** 注入时钟（单测用）。 */
	now?: () => number;
}

export class QuestionRelay {
	private pending: PendingQuestionState | undefined;
	/** cancel() 落在"发送中"这段窗口里时留下的标记（见 relay 循环里的检查）。 */
	private canceled = false;

	constructor(private readonly deps: QuestionRelayDeps) {}

	/** 当前是否有一题在等回答（dispatcher 只在 true 时才判定应答）。 */
	get busy(): boolean {
		return this.pending !== undefined;
	}

	/** 本题已发出的 QQ 消息 id（引用回复判定用）。 */
	get questionMessageIds(): readonly number[] {
		return this.pending?.messageIds ?? [];
	}

	/** 本题的触发者（未知为空串）。 */
	get askerId(): string {
		return this.pending?.askerId ?? '';
	}

	/**
	 * 逐题询问并收集答案。
	 *
	 * @param questions - 缝给的题目（顺序即提问顺序）
	 * @param signal - 本次请求的生命周期；中止即停止等待
	 */
	async relay(questions: readonly AskQuestion[], signal?: AbortSignal): Promise<RelayOutcome> {
		if (questions.length === 0) return { kind: 'timeout', budgetMs: 0 };
		this.canceled = false;
		const config = this.deps.options();
		const now = this.deps.now ?? Date.now;
		const budget = askWaitBudget({ askUserWaitMs: config.askUserWaitMs, maxTurnMs: config.maxTurnMs });
		const deadline = now() + budget;
		const answers: AskAnswerItem[] = [];
		let answered = false;
		let delivered = false;

		for (const [offset, question] of questions.entries()) {
			if (signal?.aborted === true) return { kind: 'aborted' };
			const pending: PendingQuestionState = {
				question,
				index: offset + 1,
				total: questions.length,
				askerId: this.deps.askerId(),
				messageIds: [],
			};
			this.pending = pending;
			try {
				// 先登记"正在等这一题"，再发消息：两者之间的窗口里到达的回复同样算数
				// （登记晚于发送会让"发完那一刻到的回复"掉回普通管线）。
				const waiting = this.expectReply(pending, Math.max(deadline - now(), 0), signal);
				if (!(await this.sendQuestion(pending))) {
					// 这一题一条都没发出去（transport 断开等）：后续题目同样发不出去，
					// 不必再等一个永远不会来的回复（已答的题仍在下面的 tail 里返回）。
					break;
				}
				delivered = true;
				// 发送这一小段窗口里被取消（下游应答器抢答/桥销毁）：不要再等。
				if (this.canceled) return { kind: 'aborted' };
				const outcome = await waiting;
				if (outcome.kind === 'aborted') return { kind: 'aborted' };
				if (outcome.kind === 'timeout') {
					this.logTimeout(pending, budget);
					break;
				}
				answered = true;
				const parsed = parseAskAnswer(outcome.text, question) ?? { kind: 'custom' as const, custom: outcome.text };
				answers.push(toAnswerItem(question, parsed));
			} finally {
				this.pending = undefined;
			}
		}

		if (answered) {
			// 后面没来得及问/没答上的题按"跳过"补齐：缝要求每题都有条目（与 WebUI 的"跳过本题"同形状）。
			for (const question of questions.slice(answers.length)) answers.push({ id: question.id, selected: [] });
			return { kind: 'answer', answer: { answers } };
		}
		return delivered ? { kind: 'timeout', budgetMs: budget } : { kind: 'undeliverable' };
	}

	/**
	 * 投递一条 QQ 回复（dispatcher 判定"这条消息是在回答"后调用）。
	 * @returns true = 已投给正在等的那一题
	 */
	answer(text: string, sender: { senderId: string; senderName: string }): boolean {
		const pending = this.pending;
		const settle = pending?.settle;
		if (pending === undefined || settle === undefined) return false;
		this.deps.logs?.record({
			dir: 'in',
			scope: 'dsh',
			event: 'ask-answer',
			chatType: this.deps.chatType,
			chatId: this.deps.chatId,
			senderId: sender.senderId,
			senderName: sender.senderName,
			text,
			detail: `question=${pending.question.id} ${pending.index}/${pending.total}`,
		});
		settle({ kind: 'answer', text });
		return true;
	}

	/** 中止等待（下游应答器已给答案 / 桥销毁）：relay 返回 aborted。 */
	cancel(): void {
		this.canceled = true;
		this.pending?.settle?.({ kind: 'aborted' });
	}

	/** 发一题（长问题按单条上限切块）；返回是否至少发出一块。 */
	private async sendQuestion(pending: PendingQuestionState): Promise<boolean> {
		const config = this.deps.options();
		const text = formatAskMessage({
			index: pending.index,
			total: pending.total,
			question: pending.question,
			group: this.deps.chatType === 'group',
		});
		const chunks = splitText(text, config.replyMaxChars);
		for (const [index, chunk] of chunks.entries()) {
			const segments: OBSegment[] = [];
			// 群聊里 @ 提问的触发者：群里一句话很容易被刷掉，@ 是唯一能把人叫回来的手段。
			if (index === 0 && this.deps.chatType === 'group' && pending.askerId !== '') {
				segments.push({ type: 'at', data: { qq: pending.askerId } });
			}
			segments.push({ type: 'text', data: { text: chunk } });
			const id = await this.deps.send(segments);
			if (id !== null) pending.messageIds.push(id);
		}
		this.deps.logs?.record({
			dir: 'out',
			scope: 'dsh',
			event: 'ask',
			chatType: this.deps.chatType,
			chatId: this.deps.chatId,
			senderId: pending.askerId,
			text,
			detail: `question=${pending.question.id} ${pending.index}/${pending.total}`,
		});
		if (pending.messageIds.length === 0) {
			this.deps.logger.warn(`dsh-qq-bot: ${this.deps.label} 提问发送失败（question=${pending.question.id}），本轮不再等 QQ 回答`);
		}
		return pending.messageIds.length > 0;
	}

	/** 等这一题的回答：到点算超时，signal 中止算取消，回复到达由 answer() 投递。 */
	private expectReply(pending: PendingQuestionState, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
		return new Promise<WaitOutcome>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (outcome: WaitOutcome): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				pending.settle = undefined;
				resolve(outcome);
			};
			const onAbort = (): void => finish({ kind: 'aborted' });
			timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
			if (signal !== undefined) {
				if (signal.aborted) {
					finish({ kind: 'aborted' });
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
			}
			pending.settle = (outcome) => finish(outcome);
		});
	}

	private logTimeout(pending: PendingQuestionState, budgetMs: number): void {
		this.deps.logs?.record({
			dir: 'sys',
			scope: 'dsh',
			event: 'ask-timeout',
			chatType: this.deps.chatType,
			chatId: this.deps.chatId,
			senderId: pending.askerId,
			text: `等待回答超时（${Math.round(budgetMs / 1000)}s 内没有回复）`,
			detail: `question=${pending.question.id} ${pending.index}/${pending.total}`,
		});
	}
}
