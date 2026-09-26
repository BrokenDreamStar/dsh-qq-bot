import { describe, expect, it } from 'vitest';
import {
	ASK_SKIP_WORDS,
	DEFAULT_ASK_WAIT_MS,
	MIN_ASK_WAIT_MS,
	acceptAsAnswer,
	askAbortedError,
	askTimeoutError,
	askWaitBudget,
	formatAskMessage,
	isNoAnswererError,
	parseAskAnswer,
	toAnswerItem,
	type AskQuestion,
} from './ask.ts';

const question: AskQuestion = {
	id: 'topic',
	question: '你想了解关于"爱愿妖精"的什么信息？',
	header: '选题',
	options: [
		{ label: '解释', description: '说明它是什么' },
		{ label: '故事' },
		{ label: '诗歌' },
	],
};

describe('提问文案', () => {
	it('带上问题、编号选项与"怎么回答"的提示', () => {
		const text = formatAskMessage({ index: 1, total: 1, question, group: false });
		expect(text).toContain('你想了解关于"爱愿妖精"的什么信息？');
		expect(text).toContain('〔选题〕');
		expect(text).toContain('1. 解释 — 说明它是什么');
		expect(text).toContain('3. 诗歌');
		expect(text).toContain('回复选项序号或选项内容');
		expect(text).toContain('跳过');
		// 私聊不写群聊的引用说明
		expect(text).not.toContain('在群里请引用');
	});

	it('多题标进度，多选题说明可多选', () => {
		const multi: AskQuestion = { id: 'a', question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] };
		const text = formatAskMessage({ index: 2, total: 3, question: multi, group: false });
		expect(text).toContain('2/3');
		expect(text).toContain('多个用逗号分隔');
	});

	it('群聊给出"引用本条或 @ 我"的回答方式', () => {
		const text = formatAskMessage({ index: 1, total: 1, question, group: true });
		expect(text).toContain('在群里请引用这条消息或 @ 我');
	});

	it('没有选项时只要求直接回复答案', () => {
		const open: AskQuestion = { id: 'x', question: '叫什么名字？' };
		const text = formatAskMessage({ index: 1, total: 1, question: open, group: false });
		expect(text).toContain('直接回复你的答案');
		expect(text).not.toContain('选项：');
	});

	it('detail（计划正文等）原样附在问题后', () => {
		const review: AskQuestion = { id: 'p', question: '批准这个计划吗？', detail: '## 计划\n1. 改 A' };
		const text = formatAskMessage({ index: 1, total: 1, question: review, group: false });
		expect(text).toContain('## 计划');
	});

	it('模型可见文本纪律：文案里不出现 QQ 号/群号（只有问题本身）', () => {
		const text = formatAskMessage({ index: 1, total: 1, question, group: true });
		expect(text).not.toMatch(/\d{5,}/);
	});
});

describe('回答解析', () => {
	it('序号 → 选项标签', () => {
		expect(parseAskAnswer('1', question)).toEqual({ kind: 'option', selected: ['解释'] });
		expect(parseAskAnswer('2.', question)).toEqual({ kind: 'option', selected: ['故事'] });
		expect(parseAskAnswer(' 3 ', question)).toEqual({ kind: 'option', selected: ['诗歌'] });
	});

	it('选项内容原样命中（忽略大小写与空白）', () => {
		expect(parseAskAnswer('诗歌', question)).toEqual({ kind: 'option', selected: ['诗歌'] });
		const en: AskQuestion = { id: 'a', question: 'pick', options: [{ label: 'Yes' }, { label: 'No' }] };
		expect(parseAskAnswer(' yes ', en)).toEqual({ kind: 'option', selected: ['Yes'] });
	});

	it('多选题支持多个序号（逗号/顿号/空格/全角数字）', () => {
		const multi: AskQuestion = { id: 'a', question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
		expect(parseAskAnswer('1,3', multi)).toEqual({ kind: 'option', selected: ['A', 'C'] });
		expect(parseAskAnswer('１、3', multi)).toEqual({ kind: 'option', selected: ['A', 'C'] });
		expect(parseAskAnswer('2 2', multi)).toEqual({ kind: 'option', selected: ['B'] });
	});

	it('序号越界 / 单选给多个序号 → 当自定义文本（那更像用户在打别的字）', () => {
		expect(parseAskAnswer('9', question)).toEqual({ kind: 'custom', custom: '9' });
		expect(parseAskAnswer('1 2', question)).toEqual({ kind: 'custom', custom: '1 2' });
	});

	it('自由文本 → custom（单选题由缝隙解释为覆盖选项）', () => {
		expect(parseAskAnswer('给我讲讲它的来历', question)).toEqual({ kind: 'custom', custom: '给我讲讲它的来历' });
	});

	it('跳过关键词（含英文 skip）', () => {
		for (const word of ASK_SKIP_WORDS) {
			expect(parseAskAnswer(word, question)).toEqual({ kind: 'skip' });
			expect(parseAskAnswer(word.toUpperCase(), question)).toEqual({ kind: 'skip' });
		}
	});

	it('空文本（纯图片/表情）不是回答', () => {
		expect(parseAskAnswer('   ', question)).toBeUndefined();
	});

	it('没有选项的题：一切都是自定义文本', () => {
		const open: AskQuestion = { id: 'x', question: '叫什么？' };
		expect(parseAskAnswer('小明', open)).toEqual({ kind: 'custom', custom: '小明' });
	});
});

describe('解析结果 → 缝隙答案形状', () => {
	it('选项 = selected；自定义 = custom + 空 selected；跳过 = 空 selected', () => {
		expect(toAnswerItem(question, { kind: 'option', selected: ['解释'] })).toEqual({ id: 'topic', selected: ['解释'] });
		expect(toAnswerItem(question, { kind: 'custom', custom: '讲讲来历' })).toEqual({ id: 'topic', selected: [], custom: '讲讲来历' });
		expect(toAnswerItem(question, { kind: 'skip' })).toEqual({ id: 'topic', selected: [] });
	});
});

describe('哪些消息算"在回答"', () => {
	const base = { text: '1', senderId: '1001', woke: false, questionMessageIds: [777], askerId: '1001' };

	it('私聊：任何文本消息都是回答', () => {
		expect(acceptAsAnswer({ ...base, chatType: 'private', senderId: '2002', askerId: '' })).toBe(true);
	});

	it('群聊：提问触发者本人、被唤醒的消息、引用提问消息都算', () => {
		expect(acceptAsAnswer({ ...base, chatType: 'group' })).toBe(true);
		expect(acceptAsAnswer({ ...base, chatType: 'group', senderId: '2002', askerId: '', woke: true })).toBe(true);
		expect(acceptAsAnswer({ ...base, chatType: 'group', senderId: '2002', askerId: '', replyMessageId: '777' })).toBe(true);
	});

	it('群聊：别人的普通发言不算（不把群友闲聊当答案）', () => {
		expect(acceptAsAnswer({ ...base, chatType: 'group', senderId: '2002', askerId: '1001' })).toBe(false);
		expect(acceptAsAnswer({ ...base, chatType: 'group', senderId: '2002', askerId: '1001', replyMessageId: '778' })).toBe(false);
	});

	it('空文本（纯图片）不算回答，原样落回普通管线', () => {
		expect(acceptAsAnswer({ ...base, chatType: 'private', text: '  ' })).toBe(false);
		expect(acceptAsAnswer({ ...base, chatType: 'group', text: '', woke: true })).toBe(false);
	});
});

describe('等待预算', () => {
	it('不超过单轮上限的一半（等待不产生回复，不能让 maxTurnMs 先开火）', () => {
		expect(askWaitBudget({ askUserWaitMs: 300_000, maxTurnMs: 600_000 })).toBe(300_000);
		expect(askWaitBudget({ askUserWaitMs: 300_000, maxTurnMs: 120_000 })).toBe(60_000);
	});

	it('配置为 0 用默认值；单轮上限极短时保底 MIN_ASK_WAIT_MS', () => {
		expect(askWaitBudget({ askUserWaitMs: 0, maxTurnMs: 600_000 })).toBe(DEFAULT_ASK_WAIT_MS);
		expect(askWaitBudget({ askUserWaitMs: 60_000, maxTurnMs: 2_000 })).toBe(MIN_ASK_WAIT_MS);
	});
});

describe('给缝隙的错误', () => {
	it('取消：形状对齐 dsh 的 UserQuestionError（ask 的 catch 能还原成错误分类）', () => {
		const error = askAbortedError();
		expect(error.name).toBe('UserQuestionError');
		expect((error as { code?: string }).code).toBe('ASK_ABORTED');
	});

	it('超时：中文说明 + 可读的时长', () => {
		expect(askTimeoutError(300_000).message).toContain('5 分钟');
		expect(askTimeoutError(30_000).message).toContain('30 秒');
	});

	it('NO_PROVIDER 特征识别（只有它才由本插件兜底成超时错误）', () => {
		expect(isNoAnswererError(Object.assign(new Error('x'), { code: 'NO_PROVIDER' }))).toBe(true);
		expect(isNoAnswererError(new Error('no user-questions answerer accepted the request'))).toBe(true);
		expect(isNoAnswererError(Object.assign(new Error('x'), { code: 'ASK_ABORTED' }))).toBe(false);
		expect(isNoAnswererError(undefined)).toBe(false);
	});
});
