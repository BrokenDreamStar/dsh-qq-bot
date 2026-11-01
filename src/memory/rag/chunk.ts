/**
 * 聊天窗口切块（纯逻辑，可测）。
 *
 * 为什么按“窗口”而不是单条消息：
 *  - 群聊里一句话常常只有几个字，单条 embedding 信息量太低；
 *  - 4 条 / 400 字一窗，既保留上下文，又不至于把无关话题混进来；
 *  - 1 条重叠，避免刚好被切断的问答对检索不到。
 */

import { createHash } from 'node:crypto';

export interface ChunkMessage {
	seq: number;
	ts: number;
	senderName: string;
	self: boolean;
	text: string;
}

export interface ChunkDraft {
	startSeq: number;
	endSeq: number;
	ts: number;
	text: string;
	msgCount: number;
	hash: string;
}

export interface ChunkOptions {
	/** 一个窗口最多几条消息。 */
	maxMessages: number;
	/** 一个窗口最多多少字。 */
	maxChars: number;
	/** 相邻窗口重叠几条消息。 */
	overlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
	maxMessages: 4,
	maxChars: 400,
	overlap: 1,
};

/** 渲染一行：`昵称: 内容`；机器人用“机器人”。 */
export function renderChunkLine(message: ChunkMessage): string {
	const name = message.self ? '机器人' : message.senderName.trim() || '群友';
	return `${name}: ${message.text}`;
}

/** 长消息切段（带重叠）；空文本返回空数组。 */
export function splitLongText(text: string, maxChars: number, overlap: number): string[] {
	const cleaned = text.trim();
	if (cleaned === '') return [];
	const limit = Math.max(20, Math.trunc(maxChars));
	if (cleaned.length <= limit) return [cleaned];
	const step = Math.max(1, limit - Math.max(0, Math.trunc(overlap)));
	const parts: string[] = [];
	for (let start = 0; start < cleaned.length; start += step) {
		const part = cleaned.slice(start, start + limit).trim();
		if (part !== '') parts.push(part);
		if (start + limit >= cleaned.length) break;
	}
	return parts;
}

/** chunk 内容 hash：同一 chatKey + seq 区间 + 文本只生成一次。 */
export function chunkHash(chatKey: string, startSeq: number, endSeq: number, text: string): string {
	return createHash('sha1').update(`${chatKey}\u0000${startSeq}\u0000${endSeq}\u0000${text}`).digest('hex');
}

function makeDraft(chatKey: string, window: ChunkMessage[]): ChunkDraft {
	const text = window.map(renderChunkLine).join('\n');
	const first = window[0]!;
	const last = window[window.length - 1]!;
	return {
		startSeq: first.seq,
		endSeq: last.seq,
		ts: last.ts,
		text,
		msgCount: window.length,
		hash: chunkHash(chatKey, first.seq, last.seq, text),
	};
}

/**
 * 从消息序列里取“已满”的窗口，返回草稿与未成形的尾巴。
 *
 * 这是增量写入用的版本：末尾不足一窗的消息留在 `rest`，等后续消息凑满；
 * `emitTail=true` 时把尾巴也生成 chunk（重建/启动回填用）。
 */
export function takeChunks(
	chatKey: string,
	messages: readonly ChunkMessage[],
	options: Partial<ChunkOptions> = {},
	emitTail = false,
): { drafts: ChunkDraft[]; rest: ChunkMessage[] } {
	const config: ChunkOptions = {
		maxMessages: Math.max(1, Math.trunc(options.maxMessages ?? DEFAULT_CHUNK_OPTIONS.maxMessages)),
		maxChars: Math.max(50, Math.trunc(options.maxChars ?? DEFAULT_CHUNK_OPTIONS.maxChars)),
		overlap: Math.max(0, Math.trunc(options.overlap ?? DEFAULT_CHUNK_OPTIONS.overlap)),
	};
	const drafts: ChunkDraft[] = [];
	let window: ChunkMessage[] = [];

	const flush = (): void => {
		if (window.length === 0) return;
		drafts.push(makeDraft(chatKey, window));
		const keep = Math.min(config.overlap, window.length - 1);
		window = keep > 0 ? window.slice(-keep) : [];
	};

	for (const message of messages) {
		const lines = splitLongText(renderChunkLine(message), config.maxChars, 50);
		if (lines.length > 1) {
			// 长消息先冲掉已有窗口，再逐段单独成 chunk，避免把长文和前后消息混在一起。
			flush();
			window = [];
			for (const line of lines) {
				drafts.push({
					startSeq: message.seq,
					endSeq: message.seq,
					ts: message.ts,
					text: line,
					msgCount: 1,
					hash: chunkHash(chatKey, message.seq, message.seq, line),
				});
			}
			continue;
		}
		window.push(message);
		const chars = window.reduce((sum, item) => sum + renderChunkLine(item).length + 1, 0);
		if (window.length >= config.maxMessages || chars >= config.maxChars) flush();
	}
	if (emitTail && window.length > 0) {
		drafts.push(makeDraft(chatKey, window));
		window = [];
	}
	return { drafts, rest: window };
}

/** 一次性生成全部 chunk（含尾巴），用于重建/回填。 */
export function buildChunks(chatKey: string, messages: readonly ChunkMessage[], options: Partial<ChunkOptions> = {}): ChunkDraft[] {
	return takeChunks(chatKey, messages, options, true).drafts;
}
