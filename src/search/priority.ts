/**
 * 网页搜索的后端取值与顺序列表操作（**零依赖共用**：宿主半的 config schema 与
 * 浏览器半的排序列表控件共用同一份，避免两处漂移）。与 `toolOptions.ts`、
 * `tasks/schedule.ts` 同一约定：**保持零 node / 零 dsh 依赖**，这样
 * `src/client/form.ts` / `components.tsx` 能直接 import 它，而不必把 schemastery
 * 之类的宿主依赖拖进 client bundle。
 *
 * 配置模型：`searchOrder` 是一个**有序数组**——数组顺序 = 优先级顺序，
 * 不在数组里的后端不参与搜索（相当于旧版的 none），空数组 = 网页搜索不可用。
 * WebUI 用「列表 + 行右侧上下箭头」编辑它（见 components.tsx 的 OrderListRow）。
 */

/** 网页搜索后端 id（`searchOrder` 数组的元素）。 */
export type SearchBackendId = 'exa' | 'tavily' | 'dsh';

/** 全部后端（schema 说明、WebUI 列表控件与"加入列表"按钮的选项顺序都用它）。 */
export const SEARCH_BACKEND_IDS: readonly SearchBackendId[] = ['exa', 'tavily', 'dsh'];

/**
 * 把第 `index` 项上移（delta = -1）或下移（delta = 1）一位。
 * 越界（第一项上移 / 最后一项下移 / index 不存在）返回等值的新数组，
 * 调用方拿到的永远是可直接暂存的数组（不会共享调用方的可变状态）。
 */
export function moveOrderItem(items: readonly string[], index: number, delta: -1 | 1): string[] {
	const target = index + delta;
	if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
	const next = [...items];
	const moved = next[index]!;
	next[index] = next[target]!;
	next[target] = moved;
	return next;
}

/** 追加一项到列表末尾；已存在则原样返回（不产生重复项）。 */
export function addOrderItem(items: readonly string[], entry: string): string[] {
	return items.includes(entry) ? [...items] : [...items, entry];
}

/** 从列表里移除一项；不存在则原样返回。 */
export function removeOrderItem(items: readonly string[], entry: string): string[] {
	return items.includes(entry) ? items.filter((item) => item !== entry) : [...items];
}
