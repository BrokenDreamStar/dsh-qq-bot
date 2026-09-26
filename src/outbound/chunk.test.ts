import { describe, expect, it } from 'vitest';
import { splitText } from './chunk.ts';

describe('splitText', () => {
	it('短文本不切', () => {
		expect(splitText('hello', 10)).toEqual(['hello']);
	});

	it('超长文本按上限切', () => {
		const chunks = splitText('a'.repeat(25), 10);
		expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
	});

	it('优先在换行处断开', () => {
		const text = `${'a'.repeat(8)}\n${'b'.repeat(8)}`;
		const chunks = splitText(text, 10);
		expect(chunks[0]).toBe(`${'a'.repeat(8)}\n`);
	});

	it('不切断 emoji 代理对', () => {
		const text = '😀'.repeat(5);
		const chunks = splitText(text, 3);
		for (const chunk of chunks) {
			expect(chunk.length % 2).toBe(0);
			expect(Array.from(chunk).every((c) => c === '😀')).toBe(true);
		}
	});
});
