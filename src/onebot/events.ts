/**
 * OneBot 11 事件归一化：把 message / notice / request 上报收敛为
 * 插件内部统一事件（含 chatKey 素材、@判定、引用信息）。
 */
import type { ChatType } from '../types.ts';
import {
	imageSegments,
	isAtSelf,
	parseCQ,
	replySegmentId,
	segmentsToPlainText,
	segmentsToText,
	stripLeadingAtSelf,
	type OBImageSegment,
	type OBSegment,
} from './segments.ts';

/** OneBot 上报的原始事件（保持松散，兼容各实现扩展字段）。 */
export interface RawEvent {
	post_type?: string;
	message_type?: string;
	notice_type?: string;
	request_type?: string;
	sub_type?: string;
	self_id?: number | string;
	user_id?: number | string;
	group_id?: number | string;
	target_id?: number | string;
	message_id?: number | string;
	guild_id?: number | string;
	channel_id?: number | string;
	flag?: string;
	comment?: string;
	time?: number;
	sender?: { user_id?: number | string; nickname?: string; card?: string };
	message?: OBSegment[] | string;
	raw_message?: string;
	[key: string]: unknown;
}

/** 归一化后的入站聊天消息。 */
export interface InboundMessage {
	kind: 'message';
	/** 事件里的 self_id（机器人 QQ）。 */
	selfId: string;
	chatType: ChatType;
	/** 群号或对方 QQ 号。 */
	chatId: string;
	groupId?: string;
	senderId: string;
	senderName: string;
	messageId?: number;
	/** 原始段（已保证为数组；CQ 码兜底已解析）。 */
	segments: OBSegment[];
	/** 去掉 @机器人 后的可读文本（含媒体占位）。 */
	text: string;
	/** 去掉 @机器人 后的纯文本（唤醒前缀/命令判定用）。 */
	plainText: string;
	/** 是否 @ 了机器人。 */
	mentionMe: boolean;
	/** 引用的消息 id（reply 段）。 */
	replyMessageId?: string;
	/** 是否包含图片段。 */
	hasImage: boolean;
	time: number;
}

/** 戳一戳通知（notice/notify/poke）。 */
export interface PokeNotice {
	kind: 'poke';
	selfId: string;
	chatType: ChatType;
	groupId?: string;
	senderId: string;
	targetId: string;
}

/** 好友请求。 */
export interface FriendRequestNotice {
	kind: 'friendRequest';
	selfId: string;
	userId: string;
	nickname: string;
	flag: string;
	comment: string;
}

/** 加群邀请/申请。 */
export interface GroupRequestNotice {
	kind: 'groupRequest';
	selfId: string;
	groupId: string;
	userId: string;
	nickname: string;
	flag: string;
	comment: string;
	subType: string;
}

export type InboundEvent = InboundMessage | PokeNotice | FriendRequestNotice | GroupRequestNotice;

function str(value: unknown): string {
	return value === undefined || value === null ? '' : String(value);
}

function segmentsOf(raw: RawEvent): OBSegment[] {
	if (Array.isArray(raw.message)) return raw.message;
	if (typeof raw.raw_message === 'string' && raw.raw_message !== '') return parseCQ(raw.raw_message);
	if (typeof raw.message === 'string' && raw.message !== '') return parseCQ(raw.message);
	return [];
}

/** 归一化一条原始上报；无法识别的返回 null。 */
export function normalizeEvent(raw: RawEvent): InboundEvent | null {
	const selfId = str(raw.self_id);
	if (raw.post_type === 'message' || raw.post_type === 'message_sent') {
		const chatType: ChatType = raw.message_type === 'group' ? 'group' : 'private';
		const senderId = str(raw.user_id ?? raw.sender?.user_id);
		if (senderId === '') return null;
		const chatId = chatType === 'group' ? str(raw.group_id) : senderId;
		if (chatId === '') return null;
		const rawSegments = segmentsOf(raw);
		// 引用段不进 agent 文本（原文反查属于后续增强）；@机器人 段剥离开头标记。
		const segments = stripLeadingAtSelf(
			rawSegments.filter((segment) => segment.type !== 'reply'),
			selfId,
		);
		const mentionMe = isAtSelf(rawSegments, selfId);
		return {
			kind: 'message',
			selfId,
			chatType,
			chatId,
			groupId: chatType === 'group' ? chatId : undefined,
			senderId,
			senderName: str(raw.sender?.card) || str(raw.sender?.nickname) || senderId,
			messageId: raw.message_id !== undefined ? Number(raw.message_id) : undefined,
			segments,
			text: segmentsToText(segments).trim(),
			plainText: segmentsToPlainText(segments).trim(),
			mentionMe,
			replyMessageId: replySegmentId(rawSegments),
			hasImage: imageSegments(segments).length > 0,
			time: typeof raw.time === 'number' ? raw.time : Math.floor(Date.now() / 1000),
		};
	}
	if (raw.post_type === 'notice' && raw.notice_type === 'notify' && raw.sub_type === 'poke') {
		const senderId = str(raw.user_id);
		const targetId = str(raw.target_id);
		if (senderId === '' || targetId === '') return null;
		const groupId = raw.group_id !== undefined ? str(raw.group_id) : undefined;
		return { kind: 'poke', selfId, chatType: groupId !== undefined ? 'group' : 'private', groupId, senderId, targetId };
	}
	if (raw.post_type === 'request' && raw.request_type === 'friend') {
		const userId = str(raw.user_id);
		if (userId === '' || typeof raw.flag !== 'string') return null;
		return {
			kind: 'friendRequest',
			selfId,
			userId,
			nickname: str(raw.sender?.nickname) || userId,
			flag: raw.flag,
			comment: str(raw.comment),
		};
	}
	if (raw.post_type === 'request' && raw.request_type === 'group') {
		const userId = str(raw.user_id);
		const groupId = str(raw.group_id);
		if (userId === '' || groupId === '' || typeof raw.flag !== 'string') return null;
		return {
			kind: 'groupRequest',
			selfId,
			groupId,
			userId,
			nickname: str(raw.sender?.nickname) || userId,
			flag: raw.flag,
			comment: str(raw.comment),
			subType: str(raw.sub_type) || 'add',
		};
	}
	return null;
}

/** 消息里的图片段（供媒体下载）。 */
export function messageImages(msg: InboundMessage): OBImageSegment[] {
	return imageSegments(msg.segments);
}
