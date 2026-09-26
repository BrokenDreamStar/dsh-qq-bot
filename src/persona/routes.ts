/**
 * 会话选择器：WebUI「人格与模型」表格里 `friend_<QQ号>` / `group_<群号>`
 * 与内部 chatKey（`u-<QQ号>` / `g-<群号>`）之间的互转（纯逻辑，可测）。
 *
 * 表格只面向「一个号码一个会话」，不涉及 perUser 群会话键
 * （`g-<群号>-u-<QQ号>`）；那种键由会话内 /persona、/model 命令维护。
 */

/** 选择器解析结果：scope + 号码 + 内部 chatKey。 */
export interface ChatSelector {
	scope: 'private' | 'group';
	chatId: string;
	/** 内部 chatKey（chat-overrides.json 的键）。 */
	key: string;
}

/** 私聊前缀：friend / user / 私聊 / 好友 / 用户。 */
const PRIVATE_PREFIX = /^(?:friend|user|私聊|好友|用户)[\s_:：-]*(\d+)$/i;
/** 群聊前缀：group / gorup（常见手误）/ 群 / 群聊。 */
const GROUP_PREFIX = /^(?:group|gorup|群聊|群)[\s_:：-]*(\d+)$/i;
/** 已是内部 chatKey 的写法（表格往返编辑用）。 */
const PRIVATE_KEY = /^u-(\d+)$/i;
const GROUP_KEY = /^g-(\d+)$/i;

/**
 * 解析用户输入的选择器；无法识别返回 null。
 * 接受 `friend_10001`、`friend:10001`、`friend 10001`、`私聊10001`、
 * `group_123456`、`群 123456`，以及内部键 `u-10001` / `g-123456`。
 */
export function parseChatSelector(input: string): ChatSelector | null {
	const text = input.trim();
	if (text === '') return null;
	const privateMatch = PRIVATE_PREFIX.exec(text) ?? PRIVATE_KEY.exec(text);
	if (privateMatch !== null) {
		const chatId = privateMatch[1]!;
		return { scope: 'private', chatId, key: `u-${chatId}` };
	}
	const groupMatch = GROUP_PREFIX.exec(text) ?? GROUP_KEY.exec(text);
	if (groupMatch !== null) {
		const chatId = groupMatch[1]!;
		return { scope: 'group', chatId, key: `g-${chatId}` };
	}
	return null;
}

/** 内部 chatKey → 表格显示文本；非「号码级」键返回 null。 */
export function formatChatSelector(key: string): string | null {
	const privateMatch = PRIVATE_KEY.exec(key.trim());
	if (privateMatch !== null) return `friend_${privateMatch[1]!}`;
	const groupMatch = GROUP_KEY.exec(key.trim());
	if (groupMatch !== null) return `group_${groupMatch[1]!}`;
	return null;
}

/** 该 chatKey 是否为表格可管理的「号码级」键。 */
export function isChatSelectorKey(key: string): boolean {
	return formatChatSelector(key) !== null;
}
