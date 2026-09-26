/**
 * agent 提问（dsh 的 user-questions 缝）在 QQ 侧的纯逻辑：问题文案、回答解析、
 * 应答判定、等待预算。运行时状态机在 asker.ts，本文件零依赖、可单测。
 *
 * 背景：dsh 的 `ask_user_question`（以及计划确认等走同一条缝的消费者）通过
 * `ctx.userQuestions.ask()` 派发 `user-questions/request` 瀑布，等人给答案；
 * 内置应答器只有 WebUI 的浏览器端，**QQ 用户看不到问题**，于是整轮一直等到
 * 单轮超时。本模块负责把问题改写成 QQ 消息、把 QQ 回复解析回缝隙要求的形状。
 *
 * 形状对齐 @deepseek-ai/dsh-user-questions（不引包，按运行时形状声明）：
 *  - 请求：`{ questions: [{ id, question, detail?, header?, options?, multiSelect? }], agent?, signal? }`
 *  - 答案：`{ answers: [{ id, selected: string[], custom? }] }`
 *    （单选题 custom 覆盖 selected；多选题 custom 是补充；跳过的一题写成 `selected: []`）
 *  - 失败：抛 name='UserQuestionError' 的错误（code 见 dsh 的错误分类）
 */
import type { ChatType } from '../types.ts';

/** 一个可选项（dsh 的 AskUserQuestionOption）。 */
export interface AskOption {
	label: string;
	description?: string;
}

/** 一个问题（dsh 的 AskUserQuestionItem）。 */
export interface AskQuestion {
	/** 调用方给的稳定 id，答案里原样回显。 */
	id: string;
	question: string;
	/** 补充说明（计划确认的 intent 里是计划正文），不算选项标签。 */
	detail?: string;
	/** 短标题。 */
	header?: string;
	options?: readonly AskOption[];
	/** 可多选（默认单选）。 */
	multiSelect?: boolean;
}

/** 一题的答案（dsh 的 AskUserQuestionAnswerItem）。 */
export interface AskAnswerItem {
	id: string;
	/** 选中的选项标签；单选题给了自定义文本时为空。 */
	selected: string[];
	/** 自定义文本（单选题覆盖选项，多选题补充）。 */
	custom?: string;
}

/** 一次提问的答案（dsh 的 AskUserQuestionAnswer）。 */
export interface AskAnswer {
	answers: AskAnswerItem[];
}

/** dsh 派发到 `user-questions/request` 的请求（只需本插件用到的字段）。 */
export interface AskRequest {
	questions: readonly AskQuestion[];
	/** agent 身份（派发时按 agent 作用域过滤，这里只用来反查会话桥）。 */
	agent?: { id: unknown; session?: { id: unknown } };
	/** 本次请求的生命周期（本轮取消时中止）。 */
	signal?: AbortSignal;
}

/** 跳过本题的关键词（用户回复这些词 = 不做选择）。 */
export const ASK_SKIP_WORDS = ['跳过', '跳过本题', '略过', 'skip'] as const;

/** 默认等待回答上限（ms）：与配置默认值一致，配置为 0 时兜底。 */
export const DEFAULT_ASK_WAIT_MS = 300_000;
/** 等待预算的下限（ms）：单轮上限很短时也至少给这么多，否则用户来不及看。 */
export const MIN_ASK_WAIT_MS = 5_000;

/**
 * 等待回答的预算（ms）：配置值 > 单轮上限的一半时按一半截断——
 * 等待本身不产生回复，绝不能让 maxTurnMs 先开火（与 reclaim 的等待同一考虑）。
 */
export function askWaitBudget(input: { askUserWaitMs: number; maxTurnMs: number }): number {
	const configured = input.askUserWaitMs > 0 ? input.askUserWaitMs : DEFAULT_ASK_WAIT_MS;
	const halfTurn = Math.max(Math.floor(input.maxTurnMs / 2), MIN_ASK_WAIT_MS);
	return Math.max(Math.min(configured, halfTurn), MIN_ASK_WAIT_MS);
}

/** 全角数字/顿号等归一：中文输入法下"１，２"要能当成"1,2"。 */
function normalizeText(text: string): string {
	return text
		.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
		.replace(/\uFF0C/g, ',')
		.replace(/\u3001/g, ',')
		.trim();
}

/**
 * 问题 → QQ 消息文本。
 *
 * 自解释：选项带序号、末尾一行写清怎么回答；群聊里额外说明"引用本条或 @ 我"
 * （群聊的应答判定只认这三种来源之一，见 acceptAsAnswer）。
 */
export function formatAskMessage(input: { index: number; total: number; question: AskQuestion; group: boolean }): string {
	const { question } = input;
	const head = input.total > 1 ? `【机器人提问 ${input.index}/${input.total}】` : '【机器人提问】';
	const lines = [`${head}${question.header !== undefined && question.header !== '' ? `〔${question.header}〕` : ''}${question.question}`];
	if (question.detail !== undefined && question.detail.trim() !== '') lines.push(question.detail);
	const options = question.options ?? [];
	if (options.length > 0) {
		lines.push('', '选项：');
		for (const [index, option] of options.entries()) {
			const suffix = option.description !== undefined && option.description !== '' ? ` — ${option.description}` : '';
			lines.push(`${index + 1}. ${option.label}${suffix}`);
		}
	}
	const how: string[] = [];
	if (input.group) how.push('在群里请引用这条消息或 @ 我 再回答');
	if (options.length > 0) {
		how.push(question.multiSelect === true ? '回复选项序号（多个用逗号分隔）或选项内容' : '回复选项序号或选项内容');
	} else {
		how.push('直接回复你的答案');
	}
	how.push('回复「跳过」跳过本题');
	lines.push('', `（${how.join('；')}）`);
	return lines.join('\n');
}

/** 一条 QQ 回复解析出的答案形态。 */
export type ParsedAskAnswer =
	| { kind: 'option'; selected: string[] }
	| { kind: 'custom'; custom: string }
	| { kind: 'skip' };

/**
 * QQ 回复 → 答案。
 *
 * 判定顺序（前面的优先）：选项标签原样命中 > 序号（多选允许逗号/空格分隔的多个
 * 序号）> 跳过关键词 > 自定义文本。序号越界不算选项（当自定义文本——"9" 这种
 * 回复在 3 个选项的题里更可能是用户在打别的字）。空文本返回 undefined（图片等
 * 无文本消息不会被当成回答，见 asker 的 accept 路径）。
 */
export function parseAskAnswer(text: string, question: AskQuestion): ParsedAskAnswer | undefined {
	const normalized = normalizeText(text);
	if (normalized === '') return undefined;
	const options = question.options ?? [];
	const labels = options.map((option) => option.label);
	const lowered = normalized.toLowerCase();
	const exact = labels.findIndex((label) => label.trim().toLowerCase() === lowered);
	if (exact >= 0) return { kind: 'option', selected: [labels[exact]!] };

	const tokens = normalized.split(/[\s,;，；/]+/).filter((token) => token !== '');
	const indices = tokens.map(parseOptionIndex);
	if (tokens.length > 0 && indices.every((index): index is number => index !== undefined)) {
		const picked: string[] = [];
		for (const index of new Set(indices)) {
			const label = labels[index];
			if (label !== undefined && !picked.includes(label)) picked.push(label);
		}
		if (picked.length > 0 && (question.multiSelect === true || picked.length === 1)) {
			return { kind: 'option', selected: picked };
		}
	}
	if (ASK_SKIP_WORDS.some((word) => lowered === word)) return { kind: 'skip' };
	return { kind: 'custom', custom: normalized };
}

/** "1" / "1." / "1、" → 0 基下标；不是序号返回 undefined。 */
function parseOptionIndex(token: string): number | undefined {
	const match = /^(\d{1,2})[.。)]?$/.exec(token);
	if (match === null) return undefined;
	const index = Number(match[1]) - 1;
	return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** 解析结果 → 缝隙的答案条目（越界的序号已被解析成自定义文本）。 */
export function toAnswerItem(question: AskQuestion, parsed: ParsedAskAnswer): AskAnswerItem {
	if (parsed.kind === 'option') return { id: question.id, selected: parsed.selected };
	if (parsed.kind === 'custom') return { id: question.id, selected: [], custom: parsed.custom };
	// 跳过：缝隙的约定是保留条目、选中列表为空。
	return { id: question.id, selected: [] };
}

/**
 * 这条 QQ 消息算不算"在回答"。
 *
 * 私聊：任何**文本**消息都是回答（私聊里机器人正在等回答，用户说话就是回答）。
 * 群聊（含 shared 共享会话）：只认三种来源，避免把群友的闲聊当成答案——
 *  1. 本来就会唤醒机器人的消息（@ 机器人 / 唤醒前缀）；
 *  2. 引用（QQ 的回复某个消息）**本插件刚发出的那条提问**；
 *  3. 提问的触发者本人（提问通常是回那个人的话）。
 * 空文本（纯图片/表情）不算回答，原样落回普通管线。
 */
export function acceptAsAnswer(input: {
	chatType: ChatType;
	text: string;
	senderId: string;
	/** evaluateWake 的结论：这条消息本来就会唤醒机器人（@ 或前缀）。 */
	woke: boolean;
	/** 本条消息引用的消息 id（reply 段），无引用为 undefined。 */
	replyMessageId?: string;
	/** 本次提问发出的所有 QQ 消息 id（长问题会切块）。 */
	questionMessageIds: readonly number[];
	/** 提问的触发者（未知为空串）。 */
	askerId: string;
}): boolean {
	if (input.text.trim() === '') return false;
	if (input.chatType === 'private') return true;
	if (input.woke) return true;
	if (input.askerId !== '' && input.senderId === input.askerId) return true;
	if (input.replyMessageId !== undefined) {
		return input.questionMessageIds.some((id) => String(id) === input.replyMessageId);
	}
	return false;
}

/**
 * 本轮取消时抛给缝隙的错误：形状对齐 dsh 的 UserQuestionError
 * （ask() 的 catch 会把同形状的错误还原成它的错误分类，模型因此看到
 * "未等到回答就中止"而不是一个语焉不详的 TypeError）。
 */
export function askAbortedError(): Error {
	return Object.assign(new Error('ask_user_question was aborted before the user answered（本轮已取消，QQ 侧不再等待回答）'), {
		name: 'UserQuestionError',
		code: 'ASK_ABORTED',
	});
}

/**
 * 等不到回答（QQ 侧超时且没有别的应答器）时抛给缝隙的错误。
 * 与"取消"区分开：模型据此知道用户没答，可以自行决定继续或换问法。
 */
export function askTimeoutError(waitMs: number): Error {
	const duration = waitMs >= 60_000 ? `${Math.round(waitMs / 60_000)} 分钟` : `${Math.round(waitMs / 1000)} 秒`;
	return Object.assign(new Error(`ask_user_question 等待用户回答超时（${duration}内没有回复）`), {
		name: 'UserQuestionError',
		code: 'NO_ANSWER',
	});
}

/** 提问根本没发出去（transport 未连接）且没有别的应答器时抛给缝隙的错误。 */
export function askUndeliverableError(): Error {
	return Object.assign(new Error('ask_user_question 没能发到 QQ（transport 未连接），dsh 界面也没有接手这个问题'), {
		name: 'UserQuestionError',
		code: 'UNDELIVERABLE',
	});
}

/**
 * 下游应答器"没有人接手"的错误特征（dsh 的 NO_PROVIDER）：只有这种情况才值得
 * 由本插件兜底抛超时错误；其它错误（如 ASK_ABORTED）原样透传。
 */
export function isNoAnswererError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const code = (error as { code?: unknown }).code;
	if (code === 'NO_PROVIDER') return true;
	const message = (error as { message?: unknown }).message;
	return typeof message === 'string' && message.includes('no user-questions answerer');
}
