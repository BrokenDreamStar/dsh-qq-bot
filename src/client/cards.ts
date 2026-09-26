/**
 * 设置页卡片的展开态（纯逻辑，可测）。
 *
 * 展开态**不能只放在组件的 useState 里**：保存会改 settings 文档，宿主
 * 因此重新渲染设置面板；一旦本 section 被重挂载（宿主换 key、面板重开、
 * 页面刷新），组件内状态就清零 —— 用户看到的现象是"点保存卡片自己收起来
 * 了"，还要重新点开才能继续改下一项。所以展开态存 sessionStorage：
 * 内存态负责当前会话内的重挂载（用模块级缓存，连 storage 都不可用时兜底），
 * sessionStorage 负责页面刷新后仍保持，标签页关闭即失效。
 */
import { FIELD_GROUPS } from './form.ts';

/** sessionStorage 键（前缀 dshqq-，与 UI 类名规范一致）。 */
export const OPEN_CARDS_KEY = 'dshqq-open-cards';

/** 合法的卡片 id 集合：只认 FIELD_GROUPS 里的卡片，避免历史残留键越攒越多。 */
const CARD_IDS = new Set(FIELD_GROUPS.map((group) => group.id));

/** 进程内缓存：storage 不可用（隐私模式/旧宿主/测试）时的唯一来源。 */
let memory: Record<string, boolean> = {};

function storage(): Storage | undefined {
	try {
		return typeof window === 'undefined' ? undefined : window.sessionStorage;
	} catch {
		return undefined;
	}
}

/** 只保留已知卡片 id 且值为 true 的条目（其余一律丢弃）。 */
function normalize(value: unknown): Record<string, boolean> {
	if (value === null || typeof value !== 'object') return {};
	const out: Record<string, boolean> = {};
	for (const [id, open] of Object.entries(value as Record<string, unknown>)) {
		if (open === true && CARD_IDS.has(id)) out[id] = true;
	}
	return out;
}

/** 读取展开态（内存态优先；首次调用会从 sessionStorage 载入）。 */
export function readOpenCards(): Record<string, boolean> {
	const store = storage();
	if (store !== undefined) {
		try {
			const raw = store.getItem(OPEN_CARDS_KEY);
			if (raw !== null) memory = normalize(JSON.parse(raw));
		} catch {
			// 读失败（隐私模式把 storage 访问做成抛错）或脏数据（手工改过 /
			// 旧版本格式）：退回内存态，绝不阻塞渲染。
		}
	}
	return memory;
}

/** 记住一张卡片的展开态（同时写内存态与 sessionStorage）。 */
export function writeOpenCard(id: string, open: boolean): void {
	const next = { ...readOpenCards() };
	if (open) next[id] = true;
	else delete next[id];
	memory = next;
	const store = storage();
	if (store === undefined) return;
	try {
		store.setItem(OPEN_CARDS_KEY, JSON.stringify(next));
	} catch {
		// 写失败（配额/隐私模式）：内存态仍生效，仅刷新后丢展开态。
	}
}
