/**
 * 「会话模型设置」的会话下拉（纯逻辑，可测；不依赖 react / 宿主模块）。
 *
 * 选项来自宿主 `persona/chatList.ts` 的 `routes/list.chats`——QQ 群 / 好友
 * （带名字）与本地已有会话的合并清单。这里只管两件不碰 DOM 的事：把应答
 * 解析成选项，以及判断某一行该用下拉还是文本框。
 */

/** 会话下拉的一项（宿主 ChatOption 的浏览器镜像）。 */
export interface ChatOptionView {
	chat: string;
	kind: 'private' | 'group';
	id: string;
	name?: string;
}

/** 下拉里「手动输入…」的哨兵值（真实选择器永远是 group_/friend_ 开头）。 */
export const MANUAL_CHAT_OPTION = '__manual__';

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** `routes/list` / `routes/save` 应答里的 `chats` → 下拉选项（坏条目丢弃）。 */
export function parseChatOptions(value: unknown): ChatOptionView[] {
	const raw = value !== null && typeof value === 'object' ? (value as { chats?: unknown }) : {};
	if (!Array.isArray(raw.chats)) return [];
	const options: ChatOptionView[] = [];
	for (const entry of raw.chats) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const chat = asString(row.chat);
		if (chat === '') continue;
		options.push({
			chat,
			kind: row.kind === 'group' ? 'group' : 'private',
			id: asString(row.id),
			...(asString(row.name) === '' ? {} : { name: asString(row.name) }),
		});
	}
	return options;
}

/** 下拉里显示的文字：有名字就「名字 (号码)」，没有就显示原始选择器。 */
export function chatOptionText(option: ChatOptionView): string {
	return option.name !== undefined && option.name !== '' ? `${option.name} (${option.id})` : option.chat;
}

/**
 * 一行该用下拉还是文本框：
 *  - 清单为空（未连接且没有本地会话）→ 只能手填；
 *  - 已保存的会话不在清单里（群被踢、会话目录被删）→ 也必须显示成文本框，
 *    否则下拉会把它显示成空值，保存一次就静默丢配置；
 *  - 用户显式选了「手动输入…」→ 文本框。
 */
export function chatFieldMode(row: { chat: string; manual?: boolean }, known: ReadonlySet<string>): 'picker' | 'manual' {
	if (known.size === 0) return 'manual';
	if (row.manual === true) return 'manual';
	const chat = row.chat.trim();
	return chat !== '' && !known.has(chat) ? 'manual' : 'picker';
}
