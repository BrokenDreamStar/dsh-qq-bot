import { describe, expect, it } from 'vitest';
import { isAtSelf, parseCQ, replySegmentId, segmentsToCQ, segmentsToPlainText, segmentsToText, stripLeadingAtSelf } from './segments.ts';

describe('parseCQ', () => {
	it('解析纯文本', () => {
		expect(parseCQ('你好')).toEqual([{ type: 'text', data: { text: '你好' } }]);
	});

	it('解析 CQ 码与文本混合', () => {
		const segments = parseCQ('看[CQ:image,file=abc.jpg,url=https://x/y.jpg]这个');
		expect(segments).toHaveLength(3);
		expect(segments[0]).toEqual({ type: 'text', data: { text: '看' } });
		expect(segments[1]).toMatchObject({ type: 'image', data: { file: 'abc.jpg', url: 'https://x/y.jpg' } });
		expect(segments[2]).toEqual({ type: 'text', data: { text: '这个' } });
	});

	it('解析转义字符', () => {
		const segments = parseCQ('[CQ:text]&#91;转义&#93;&amp;ok');
		expect(segmentsToText(segments)).toBe('[转义]&ok');
	});

	it('CQ 参数中的转义逗号', () => {
		const segments = parseCQ('[CQ:at,qq=123,name=&#44;x&#44;]');
		expect(segments[0]).toMatchObject({ type: 'at', data: { qq: '123', name: ',x,' } });
	});

	it('连续 CQ 码', () => {
		const segments = parseCQ('[CQ:face,id=1][CQ:face,id=2]');
		expect(segments).toHaveLength(2);
		expect(segments[1]).toMatchObject({ type: 'face', data: { id: '2' } });
	});
});

describe('segmentsToCQ', () => {
	it('往返：段 → CQ → 段 保留语义', () => {
		const segments = [
			{ type: 'text' as const, data: { text: 'a[b]&c' } },
			{ type: 'image' as const, data: { file: 'x.jpg' } },
		];
		const parsed = parseCQ(segmentsToCQ(segments));
		expect(parsed[0]).toEqual({ type: 'text', data: { text: 'a[b]&c' } });
		expect(parsed[1]).toMatchObject({ type: 'image', data: { file: 'x.jpg' } });
	});
});

describe('segmentsToText', () => {
	it('文本直出，媒体给占位符', () => {
		const text = segmentsToText([
			{ type: 'text', data: { text: 'hi ' } },
			{ type: 'image', data: { file: 'a.jpg' } },
			{ type: 'at', data: { qq: 'all' } },
		]);
		expect(text).toBe('hi [图片]@全体成员');
	});

	it('reply 段带消息 id', () => {
		const text = segmentsToText([{ type: 'reply', data: { id: '42' } }]);
		expect(text).toBe('[回复:42]');
	});
});

describe('segmentsToPlainText', () => {
	it('只取文本段', () => {
		const plain = segmentsToPlainText([
			{ type: 'image', data: { file: 'a.jpg' } },
			{ type: 'text', data: { text: '/status' } },
		]);
		expect(plain).toBe('/status');
	});
});

describe('isAtSelf / stripLeadingAtSelf', () => {
	const segments = [
		{ type: 'at', data: { qq: '10000' } },
		{ type: 'text', data: { text: ' 在吗' } },
	];
	it('识别 @机器人', () => {
		expect(isAtSelf(segments, '10000')).toBe(true);
		expect(isAtSelf(segments, '99999')).toBe(false);
		expect(isAtSelf([{ type: 'at', data: { qq: 'all' } }], '10000')).toBe(false);
	});
	it('剥离开头的 @机器人 与空白', () => {
		const stripped = stripLeadingAtSelf(segments, '10000');
		expect(stripped).toEqual([{ type: 'text', data: { text: ' 在吗' } }]);
	});
	it('reply 段 id 提取', () => {
		expect(replySegmentId([{ type: 'reply', data: { id: '77' } }])).toBe('77');
		expect(replySegmentId([{ type: 'text', data: { text: 'x' } }])).toBeUndefined();
	});
});
