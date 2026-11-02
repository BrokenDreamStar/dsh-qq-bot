/**
 * 记忆文本处理：中文分词、查询词元、QQ 号清洗。
 *
 * 为什么需要它：SQLite FTS5 的 `unicode61` 把一整句连续汉字当成**一个 token**
 * （实测：`MATCH '天'` 对「今天天气不错」返回 0 行），所以索引与查询都必须先
 * 用 `Intl.Segmenter` 分词，再用空格连接。`trigram` 也不能单独用：它只索引
 * 3 字符序列，2 字中文查询（"备份""张三"）会返回 0 行。
 *
 * 本文件是宿主半专用（`Intl.Segmenter` 在 Node 22+ 可用），不要被 client
 * bundle 引用。
 */

/** 句子里连续 5–12 位数字的 QQ 号：括号形式 `(12345)` 或 @ 形式 `@12345`。 */
const QQ_NUMBER_PATTERN = /\(\d{5,12}\)|@\d{5,12}/g;

/**
 * 去掉模型可见文本里的 QQ 号。
 *
 * 只处理"括号里的号码"与"@号码"，不动版本号/普通数字（避免误伤）。
 * 用户明确要求：机器人在群里提人不要输出号码；模型看到什么就会照抄什么。
 */
export function stripQqNumbers(text: string): string {
	return text
		.replace(QQ_NUMBER_PATTERN, '')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** 分词结果（保留原始大小写；检索时统一小写）。 */
function segmentWords(text: string): string[] {
	const Segmenter = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: 'word' }) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
	if (typeof Segmenter === 'function') {
		const segmenter = new Segmenter('zh', { granularity: 'word' });
		const words: string[] = [];
		for (const part of segmenter.segment(text)) {
			if (part.isWordLike === false) continue;
			const word = part.segment.trim();
			if (word !== '') words.push(word);
		}
		return words;
	}
	// 兜底（老 Node 没有 Intl.Segmenter）：按 ASCII 词 + 单个 CJK 字符切。
	const words: string[] = [];
	const re = /[a-zA-Z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
	let match = re.exec(text);
	while (match !== null) {
		words.push(match[0]);
		match = re.exec(text);
	}
	return words;
}

/**
 * 写入侧分词：空格连接，供 FTS5 索引。
 *
 * 例：`张三说的备份方案还是用 restic 吧`
 * → `张三 说的 备份 方案 还是 用 restic 吧`
 */
export function segmentText(text: string): string {
	return segmentWords(text).join(' ');
}

/**
 * 查询侧词元：小写、去重、限制数量。
 *
 * 与 `segmentText` 使用同一套分词，保证查询词能命中索引 token。
 * 至少 1 个字符；纯标点/空查询返回空数组。
 */
export function tokenizeQuery(query: string): string[] {
	const cleaned = stripQqNumbers(query).toLowerCase();
	const tokens = segmentWords(cleaned)
		.map((word) => word.toLowerCase())
		.filter((word) => word !== '')
		// 丢单字母 ASCII 噪音（旧行为）；保留单个汉字/数字（版本号、人名首字）。
		.filter((word) => word.length > 1 || /[0-9]/.test(word) || /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(word));
	return [...new Set(tokens)].slice(0, 24);
}

/** 记忆条目的内容 hash（去重 + tombstone 用；不引入加密依赖）。 */
export function contentHash(text: string): string {
	let hash = 2166136261;
	const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
	for (let index = 0; index < normalized.length; index += 1) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

/**
 * 自然语言"元指令"：在对机器人说"怎么处理记忆"，不是关于世界的事实。
 *
 * 这类消息不应该写进长期记忆（否则"把刚才那条删了"会变成一条用户偏好）。
 * 保守匹配，避免误伤"记住我喜欢简短回复"这类真正的记忆请求——「记住」
 * 只靠普通聊天进 RAG。
 */
const META_COMMAND_PATTERNS: readonly RegExp[] = [
	/^(把)?(刚才|刚刚|之前|上一条|那条|这条).{0,8}(删|删掉|删除|忘|忘掉|取消)/,
	/^(忘掉|忘记|别记|不要记|不用记|删掉|删除)(这个|它|我|刚才|这条|那条)?/,
	/^(请)?(你)?(记住我说的|记住刚才|记住这条|记下我刚才)/,
	/^(记忆|长期记忆).{0,6}(删|删除|清空|清除|忘)/,
	/^(不要|别)(再)?(提|记)(这个|那件事|刚才)/,
];

/** 是否是自然语言元指令（应排除在长期记忆写入之外）。 */
export function isMetaCommand(text: string): boolean {
	const normalized = text.trim();
	if (normalized === '') return false;
	return META_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}
