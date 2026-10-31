/**
 * L0 常驻卡片：纯逻辑（预算打包、渲染、容量错误文案），不碰数据库。
 *
 * 设计要点（见 docs/memory-design.md §5）：
 *  1. 预算按**字符**而非 token —— 换模型不用重算，且模型无关（Hermes 同款）；
 *  2. 超预算不是「静默截断」而是**报错 + 当前条目 + 使用率**，逼模型在同一轮里
 *     自己整理（合并/删除）后重试；截断会静默丢信息，报错不会；
 *  3. 排序与打包是确定性的（pinned > confidence > updatedAt 新 > id 大），
 *     被挤出的条数以「还有 N 条未展开」写进卡片末尾 —— 这是给模型的**索引提示**，
 *     比每轮全量注入便宜得多。
 */

import { sanitizeMemoryText } from './guard.ts';
import { stripQqNumbers } from './text.ts';
import { CARD_HEADER, MEMBER_PROFILE_HEADER, MEMORY_SAFETY_NOTE, type MemoryFact } from './types.ts';

export interface CardRender {
	/** 完整卡片文本（含表头与安全声明）；空卡片返回空串。 */
	text: string;
	/** 实际装进卡片的条数。 */
	included: number;
	/** 因预算被挤出的条数（>0 时卡片末尾有提示行）。 */
	omitted: number;
	/** 已用字符数（不含表头/声明，只算条目与提示行）。 */
	usedChars: number;
}

/** 条目是否仍应参与注入/容量计算。 */
export function isActiveFact(fact: MemoryFact, now = Date.now()): boolean {
	if (fact.status !== undefined && fact.status !== 'active') return false;
	if (fact.supersededBy !== null) return false;
	if (fact.expiresAt !== null && fact.expiresAt !== undefined && fact.expiresAt <= now) return false;
	return true;
}

/** 条目的自然语言正文（兼容旧结构化条目）。 */
export function factText(fact: MemoryFact): string {
	const content = fact.content?.trim();
	if (content !== undefined && content !== '') return content;
	return [fact.subject, fact.predicate, fact.object].filter((part) => part.trim() !== '').join(' ');
}

/** 成员画像只收身份/偏好/规则/长期计划；一次性事件与普通事实不进画像。 */
export function isMemberProfileFact(fact: MemoryFact): boolean {
	const kind = fact.kind ?? 'fact';
	return kind === 'profile' || kind === 'preference' || kind === 'rule' || kind === 'plan';
}

/** 参与卡片排序的比较函数（导出便于测试）。 */
export function compareFacts(a: MemoryFact, b: MemoryFact): number {
	if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
	const ai = a.importance ?? 0.5;
	const bi = b.importance ?? 0.5;
	if (bi !== ai) return bi - ai;
	if (b.confidence !== a.confidence) return b.confidence - a.confidence;
	if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
	return b.id - a.id;
}

/** 单条条目的渲染文本（不含序号）。 */
export function renderFactLine(fact: MemoryFact): string {
	const pinned = fact.pinned ? '[置顶] ' : '';
	return `${pinned}${sanitizeMemoryText(stripQqNumbers(factText(fact)))}`;
}

/**
 * 按预算打包并渲染卡片。
 *
 * @param facts - 该 chatKey 的全部活跃事实（未排序也可）。
 * @param options - `maxChars` 条目预算；`chatLabel` 表头里的会话称呼；
 *   `visibilityThreshold` 低于该置信度的事实不注入（默认 0.4）。
 * @returns 渲染结果；无可用事实时 `text` 为空串。
 */
export function renderCard(
	facts: readonly MemoryFact[],
	options: { maxChars: number; chatLabel?: string; visibilityThreshold?: number; now?: number },
): CardRender {
	const threshold = options.visibilityThreshold ?? 0.4;
	const budget = Math.max(0, Math.trunc(options.maxChars));
	const now = options.now ?? Date.now();
	const candidates = facts
		.filter(
			(fact) =>
				isActiveFact(fact, now) &&
				fact.confidence >= threshold &&
				sanitizeMemoryText(factText(fact)) !== '',
		)
		.sort(compareFacts);

	const lines: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const fact of candidates) {
		// 先按最坏情况的序号宽度（3 位）估预算，避免"看起来没超、加上序号就超"。
		const width = `${lines.length + 1}. `.length;
		const cost = renderFactLine(fact).length + width;
		// 第一条即使装不下也保留：空卡片比轻微超出更糟（模型看不到任何记忆）。
		if (lines.length > 0 && used + cost > budget) {
			omitted += 1;
			continue;
		}
		lines.push(renderFactLine(fact));
		used += cost;
	}
	if (lines.length === 0) {
		return { text: '', included: 0, omitted: candidates.length, usedChars: 0 };
	}

	const body = lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
	const hint = omitted > 0 ? `\n（另有 ${omitted} 条未展开，需要时用 qq_recall_memory 检索）` : '';
	const label = options.chatLabel !== undefined && options.chatLabel !== '' ? `·${options.chatLabel}` : '';
	const header = `${CARD_HEADER}${label}（${lines.length}/${candidates.length} 条）`;
	return {
		text: `${header}\n${body}${hint}\n${MEMORY_SAFETY_NOTE}`,
		included: lines.length,
		omitted,
		usedChars: used,
	};
}

/**
 * 渲染单个成员的画像（每轮只给当前说话人/被引用者，不进 system prompt）。
 *
 * 与群卡片共用预算/排序/安全声明，但表头与筛选不同：只收 profile/preference/rule/plan。
 */
export function renderMemberProfile(
	facts: readonly MemoryFact[],
	options: { name: string; maxChars: number; visibilityThreshold?: number; now?: number },
): CardRender {
	const threshold = options.visibilityThreshold ?? 0.4;
	const budget = Math.max(0, Math.trunc(options.maxChars));
	const now = options.now ?? Date.now();
	const candidates = facts
		.filter(
			(fact) =>
				isActiveFact(fact, now) &&
				isMemberProfileFact(fact) &&
				fact.confidence >= threshold &&
				sanitizeMemoryText(factText(fact)) !== '',
		)
		.sort(compareFacts);
	const lines: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const fact of candidates) {
		const width = `${lines.length + 1}. `.length;
		const cost = renderFactLine(fact).length + width;
		if (lines.length > 0 && used + cost > budget) {
			omitted += 1;
			continue;
		}
		lines.push(renderFactLine(fact));
		used += cost;
	}
	if (lines.length === 0) return { text: '', included: 0, omitted: candidates.length, usedChars: 0 };
	const body = lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
	const hint = omitted > 0 ? `\n（另有 ${omitted} 条未展开，需要时用 qq_recall_memory 检索）` : '';
	const safeName = stripQqNumbers(sanitizeMemoryText(options.name)).trim();
	const name = safeName === '' ? '群友' : safeName;
	return {
		text: `${MEMBER_PROFILE_HEADER}·${name}（${lines.length}/${candidates.length} 条）\n${body}${hint}\n${MEMORY_SAFETY_NOTE}`,
		included: lines.length,
		omitted,
		usedChars: used,
	};
}

/** 卡片当前占用的字符数（= 所有活跃条目的渲染长度之和，含序号）。 */
export function cardUsage(facts: readonly MemoryFact[]): number {
	return facts
		.filter((fact) => isActiveFact(fact))
		.reduce((total, fact) => total + renderFactLine(fact).length + 2, 0);
}

/** 容量视图（工具返回与 WebUI 展示用）。 */
export interface CardUsage {
	used: number;
	limit: number;
	/** `612/600` 形态。 */
	label: string;
	/** 0~1 以上（可能 >1，表示已超限）。 */
	ratio: number;
	entries: string[];
}

/** 组装使用率信息（Hermes 的 `usage` 字段语义）。 */
export function describeUsage(facts: readonly MemoryFact[], maxChars: number): CardUsage {
	const active = facts.filter((fact) => isActiveFact(fact)).sort(compareFacts);
	const used = cardUsage(facts);
	const limit = Math.max(0, Math.trunc(maxChars));
	return {
		used,
		limit,
		label: `${used}/${limit}`,
		ratio: limit === 0 ? (used > 0 ? 2 : 0) : used / limit,
		entries: active.map(renderFactLine),
	};
}

/** 新增一条事实时是否还有空间（不含截断：超了就让调用方报错）。 */
export function canAdd(facts: readonly MemoryFact[], maxChars: number, addition: string): boolean {
	return cardUsage(facts) + sanitizeMemoryText(addition).length + 2 <= Math.max(0, Math.trunc(maxChars));
}

/**
 * 容量已满时的错误文案（工具返回给模型；Hermes 的 `Memory at 2,100/2,200 chars...` 同款）。
 * 关键词：告诉模型**在同一轮内**整理后重试、把当前条目带回去、给出使用率。
 */
export function buildCapacityError(usage: CardUsage, additionChars: number): string {
	return (
		`长期记忆已满：当前 ${usage.label} 字，新增这条约 ${additionChars} 字会超出上限。` +
		'请立刻整理：用 replace 把重叠条目合并成更短的一条，或用 remove 删掉过时/不重要的条目，' +
		'然后**在本轮内重试**这次写入（当前条目见 current_entries）。'
	);
}
