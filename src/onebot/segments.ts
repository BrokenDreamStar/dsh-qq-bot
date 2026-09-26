/**
 * OneBot 11 消息段模型：类型、CQ 码解析/序列化、纯文本渲染。
 *
 * 优先使用 message 段数组；CQ 码字符串作为兜底（部分实现只给 raw_message）。
 * 转义规则见 OneBot v11 规范：文本中 & [ ] 需转义，CQ 参数中额外转义 , 。
 */

export interface OBTextSegment {
	type: 'text';
	data: { text: string };
}

export interface OBAtSegment {
	type: 'at';
	data: { qq: string };
}

export interface OBImageSegment {
	type: 'image';
	data: { file: string; url?: string; file_id?: string; path?: string };
}

export interface OBReplySegment {
	type: 'reply';
	data: { id: string };
}

export interface OBRecordSegment {
	type: 'record';
	data: { file: string; url?: string };
}

export interface OBFaceSegment {
	type: 'face';
	data: { id: string };
}

export interface OBPokeSegment {
	type: 'poke';
	data: { qq?: string; id?: string };
}

export interface OBForwardSegment {
	type: 'forward';
	data: { id: string };
}

export interface OBNodeSegment {
	type: 'node';
	data: { uin?: string; name?: string; content: string | OBSegment[]; id?: string };
}

/** 任意其它段（video/file/json/xml/share/music/contact/…）。 */
export interface OBGenericSegment {
	type: string;
	data: Record<string, unknown>;
}

export type OBSegment =
	| OBTextSegment
	| OBAtSegment
	| OBImageSegment
	| OBReplySegment
	| OBRecordSegment
	| OBFaceSegment
	| OBPokeSegment
	| OBForwardSegment
	| OBNodeSegment
	| OBGenericSegment;

const CQ_ESCAPE_TEXT: Record<string, string> = { '&': '&amp;', '[': '&#91;', ']': '&#93;' };
const CQ_ESCAPE_PARAM: Record<string, string> = { '&': '&amp;', '[': '&#91;', ']': '&#93;', ',': '&#44;' };

function unescapeCQ(value: string): string {
	return value
		.replace(/&#44;/g, ',')
		.replace(/&#91;/g, '[')
		.replace(/&#93;/g, ']')
		.replace(/&amp;/g, '&');
}

function escapeText(value: string): string {
	return value.replace(/[&[\]]/g, (c) => CQ_ESCAPE_TEXT[c] ?? c);
}

function escapeParam(value: string): string {
	return value.replace(/[&[\],]/g, (c) => CQ_ESCAPE_PARAM[c] ?? c);
}

/** 解析 CQ 码字符串为消息段数组（纯文本段保持原文）。 */
export function parseCQ(raw: string): OBSegment[] {
	const segments: OBSegment[] = [];
	const pattern = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^[\]]*)*)\]/g;
	let cursor = 0;
	for (const match of raw.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) {
			const text = unescapeCQ(raw.slice(cursor, index));
			if (text !== '') segments.push({ type: 'text', data: { text } });
		}
		const type = match[1] ?? 'unknown';
		const data: Record<string, unknown> = {};
		for (const pair of (match[2] ?? '').split(',')) {
			const eq = pair.indexOf('=');
			if (eq <= 0) continue;
			const key = pair.slice(0, eq).trim();
			if (key === '') continue;
			data[key] = unescapeCQ(pair.slice(eq + 1));
		}
		segments.push({ type, data } as OBSegment);
		cursor = index + match[0].length;
	}
	if (cursor < raw.length) {
		const text = unescapeCQ(raw.slice(cursor));
		if (text !== '') segments.push({ type: 'text', data: { text } });
	}
	return segments;
}

/** 序列化消息段为 CQ 码字符串（发送兜底用；正常发送走段数组）。 */
export function segmentsToCQ(segments: OBSegment[]): string {
	return segments
		.map((segment) => {
			if (segment.type === 'text') return escapeText(String((segment.data as { text?: string }).text ?? ''));
			const params = Object.entries(segment.data)
				.filter(([, value]) => value !== undefined && value !== null)
				.map(([key, value]) => `${key}=${escapeParam(String(value))}`)
				.join(',');
			return `[CQ:${segment.type}${params === '' ? '' : ','}${params}]`;
		})
		.join('');
}

const PLACEHOLDER_LABELS: Record<string, string> = {
	image: '[图片]',
	face: '[表情]',
	record: '[语音]',
	video: '[视频]',
	reply: '[回复]',
	forward: '[合并转发]',
	json: '[JSON消息]',
	xml: '[XML消息]',
	share: '[分享]',
	contact: '[名片]',
	location: '[位置]',
	music: '[音乐]',
	file: '[文件]',
	'rich.text': '[富文本]',
};

/** 渲染段数组为人类可读文本（进 agent 的主体；非文本段给可读占位）。 */
export function segmentsToText(segments: OBSegment[]): string {
	let out = '';
	for (const segment of segments) {
		const data = segment.data as Record<string, unknown>;
		switch (segment.type) {
			case 'text':
				out += String(data.text ?? '');
				break;
			case 'at':
				out += data.qq === 'all' ? '@全体成员' : `@${String(data.qq ?? '')}`;
				break;
			case 'reply':
				out += `[回复:${String(data.id ?? '')}]`;
				break;
			case 'poke':
				out += '[戳一戳]';
				break;
			default:
				out += PLACEHOLDER_LABELS[segment.type] ?? `[${segment.type}]`;
		}
	}
	return out;
}

/** 仅提取纯文本段（唤醒前缀与命令判定用，占位符不参与）。 */
export function segmentsToPlainText(segments: OBSegment[]): string {
	return segments
		.filter((s): s is OBTextSegment => s.type === 'text')
		.map((s) => s.data.text)
		.join('');
}

/** 段数组里是否有 @指定对象（qq='all' 不算）。 */
export function isAtSelf(segments: OBSegment[], selfId: string): boolean {
	if (selfId === '') return false;
	return segments.some((s) => s.type === 'at' && String((s.data as Record<string, unknown>).qq ?? '') === String(selfId));
}

/** 去掉紧邻开头的 @机器人 段（@后直接跟文本的典型形态）。 */
export function stripLeadingAtSelf(segments: OBSegment[], selfId: string): OBSegment[] {
	const out = [...segments];
	while (out.length > 0) {
		const first = out[0];
		if (first === undefined) break;
		if (first.type === 'text' && String((first.data as { text?: string }).text ?? '').trim() === '') {
			out.shift();
			continue;
		}
		if (first.type === 'at' && String((first.data as Record<string, unknown>).qq ?? '') === String(selfId)) {
			out.shift();
			continue;
		}
		break;
	}
	return out;
}

/** 收集图片段。 */
export function imageSegments(segments: OBSegment[]): OBImageSegment[] {
	return segments.filter((s): s is OBImageSegment => s.type === 'image');
}

/** 取 reply 段的引用消息 id。 */
export function replySegmentId(segments: OBSegment[]): string | undefined {
	const reply = segments.find((s) => s.type === 'reply');
	if (reply === undefined) return undefined;
	return String((reply.data as Record<string, unknown>).id ?? '') || undefined;
}
