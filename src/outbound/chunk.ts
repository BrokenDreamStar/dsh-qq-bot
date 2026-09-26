/**
 * 出站文本分块：按字符上限切（换行优先、不切断代理对）。
 * 单条上限是 QQ 的硬约束；超长文本的"聊天记录转发"是另一条路径，
 * 见 bridge/chat.ts 的 reply()。
 */

/** 把长文本切成 ≤ maxChars 的块（优先在换行处断开）。 */
export function splitText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		const newline = window.lastIndexOf('\n');
		let cut = newline > maxChars * 0.5 ? newline + 1 : maxChars;
		// 不从代理对（emoji 等）中间切开。
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
		if (cut <= 0) cut = Math.min(2, rest.length);
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest !== '') chunks.push(rest);
	return chunks;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
