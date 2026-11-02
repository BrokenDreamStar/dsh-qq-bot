/**
 * 设置页左侧导航的选中项（纯逻辑，可测）。
 *
 * 选中项**不能只放在组件的 useState 里**：保存会改 settings 文档，宿主
 * 因此重新渲染设置面板；一旦本 section 被重挂载（宿主换 key、面板重开、
 * 页面刷新），组件内状态就清零 —— 用户看到的现象是"改完一项被踢回第一张卡"。
 * 所以选中项存 sessionStorage：内存态负责当前会话内的重挂载（用模块级缓存，
 * 连 storage 都不可用时兜底），sessionStorage 负责页面刷新后仍保持，
 * 标签页关闭即失效。
 */
import { FIELD_GROUPS } from './form.ts';

/** 当前导航选中的卡片（设置页一次只展示一个功能域）。 */
export const ACTIVE_CARD_KEY = 'dshqq-active-card';

/** 合法的卡片 id 集合：只认 FIELD_GROUPS 里的卡片，避免历史残留键越攒越多。 */
const CARD_IDS = new Set(FIELD_GROUPS.map((group) => group.id));

/**
 * 历史卡片 id → 现行 id：旧的「会话人格」卡已并入「人格」卡（模板库 + 会话
 * 人格两个子分节）；「唤醒」「回复形态」「媒体与互动」「提问与问答」四张卡
 * 已合并成「对话与互动」（behavior）；「聊天记录」已并入「成员与信息」
 * （roster）；「记忆库与技能」独立卡已删除，停留过的浏览器切到同一功能域的
 * 配置卡（memory，长期记忆）。只做选中项迁移，避免停在旧卡的浏览器刷新后
 * 跳回第一张卡。
 */
const LEGACY_CARD_IDS: Record<string, string> = {
	souls: 'personas',
	wake: 'behavior',
	reply: 'behavior',
	media: 'behavior',
	ask: 'behavior',
	history: 'roster',
	memoryItems: 'memory',
};

/** 进程内缓存：storage 不可用（隐私模式/旧宿主/测试）时的唯一来源。 */
let activeMemory: string | undefined;

function storage(): Storage | undefined {
	try {
		return typeof window === 'undefined' ? undefined : window.sessionStorage;
	} catch {
		return undefined;
	}
}

/** 读取上次打开的功能域；未知/缺失时回退到第一张卡片。 */
export function readActiveCard(fallback = 'connection'): string {
	const store = storage();
	if (store !== undefined) {
		try {
			const raw = store.getItem(ACTIVE_CARD_KEY);
			if (raw !== null) {
				const id = LEGACY_CARD_IDS[raw] ?? raw;
				activeMemory = CARD_IDS.has(id) ? id : undefined;
			}
		} catch {
			// storage 不可用时只使用内存态。
		}
	}
	return activeMemory !== undefined && CARD_IDS.has(activeMemory) ? activeMemory : fallback;
}

/** 记住当前功能域，页面重挂载/刷新后仍停在原处。 */
export function writeActiveCard(id: string): void {
	if (!CARD_IDS.has(id)) return;
	activeMemory = id;
	const store = storage();
	if (store === undefined) return;
	try {
		store.setItem(ACTIVE_CARD_KEY, id);
	} catch {
		// 写失败时仍保留内存态。
	}
}
