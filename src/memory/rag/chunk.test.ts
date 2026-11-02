import { describe, expect, it } from 'vitest';
import { chunkHash, renderChunkLine, splitLongText, takeChunks, type ChunkMessage } from './chunk.ts';

function message(seq: number, text: string, name = '张三'): ChunkMessage {
	return { seq, ts: 1000 + seq, senderName: name, self: false, text };
}

describe('chunk：窗口切块', () => {
	it('按条数切窗，保留 overlap', () => {
		const messages = [message(1, 'a'), message(2, 'b'), message(3, 'c')];
		const { drafts, rest } = takeChunks('g-1', messages, { maxMessages: 2, maxChars: 1000, overlap: 1 }, false);
		expect(drafts.map(draft => [draft.startSeq, draft.endSeq])).toEqual([
			[1, 2],
			[2, 3],
		]);
		expect(rest.map(item => item.seq)).toEqual([3]);
	});

	it('按字数切窗', () => {
		const messages = [message(1, '一二三四五六七八九十'), message(2, '一二三四五六七八九十'), message(3, '一二三四五六七八九十'), message(4, '一二三四五六七八九十')];
		const { drafts } = takeChunks('g-1', messages, { maxMessages: 10, maxChars: 60, overlap: 0 }, false);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]!.text).toContain('张三');
	});

	it('末尾不足一窗：增量模式留在 rest，重建模式生成 chunk', () => {
		const messages = [message(1, 'a')];
		expect(takeChunks('g-1', messages, { maxMessages: 4, maxChars: 400, overlap: 1 }, false).drafts).toEqual([]);
		expect(takeChunks('g-1', messages, { maxMessages: 4, maxChars: 400, overlap: 1 }, true).drafts).toHaveLength(1);
	});

	it('长消息切段并单独成 chunk', () => {
		const long = '字'.repeat(250);
		const { drafts } = takeChunks('g-1', [message(1, long)], { maxMessages: 4, maxChars: 100, overlap: 0 }, false);
		expect(drafts.length).toBeGreaterThan(2);
		expect(drafts.every(draft => draft.text.length <= 110)).toBe(true);
	});

	it('文本行只给昵称，机器人用“机器人”', () => {
		expect(renderChunkLine({ seq: 1, ts: 0, senderName: '李四', self: false, text: 'hi' })).toBe('李四: hi');
		expect(renderChunkLine({ seq: 1, ts: 0, senderName: '李四', self: true, text: 'hi' })).toBe('机器人: hi');
	});

	it('hash 受 chatKey 影响', () => {
		expect(chunkHash('g-1', 1, 2, 'x')).not.toBe(chunkHash('g-2', 1, 2, 'x'));
	});

	it('splitLongText 保留重叠', () => {
		const parts = splitLongText('abcdefghijklmnopqrstuvwxyz', 20, 5);
		expect(parts[0]).toBe('abcdefghijklmnopqrst');
		expect(parts[1]!.startsWith('pqrst')).toBe(true);
	});
});
