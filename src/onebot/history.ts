/**
 * 聊天记录：让 agent 在被唤醒时能**主动**读取"刚才群里在聊什么"。
 *
 * 两个数据源合并（同 message_id 去重，本地条目优先——它的文本是本插件
 * 实时渲染的，含媒体占位）：
 *  1. 本地缓冲：本插件收到并**通过访问控制**的所有消息（含没有唤醒机器人的
 *     普通发言与机器人自己的发言）。只在运行期间有效，**不落盘**——它是
 *     "上下文"，不是审计日志；信息过滤前缀命中的消息在管线里已被整条丢弃，
 *     根本不会进缓冲；
 *  2. OneBot 历史接口（`get_group_msg_history` / `get_friend_msg_history`）：
 *     能回溯到机器人启动之前，但对可回溯窗口有上限、部分实现不支持，
 *     失败即静默回退本地缓冲。
 *
 * 本地缓冲是内存环形缓冲（每会话 historyBufferPerChat 条，最多跟踪
 * HISTORY_MAX_CHATS 个会话），任何写入都不抛错——它绝不能影响消息主链路。
 * 渲染成给模型看的"记录"由 renderTranscript 负责（只读、纯函数）。
 */
import type { DshQQConfig } from '../config.ts';
import type { ChatType, Logger } from '../types.ts';
import type { InboundMessage } from './events.ts';
import type { MsgResult, OneBotApi } from './api.ts';
import { parseCQ, segmentsToText, type OBSegment } from './segments.ts';

/** 单条聊天记录（本地与远端统一表示）。 */
export interface ChatHistoryEntry {
	chatType: ChatType;
	chatId: string;
	/** OneBot message_id；缺失时无法与远端条目去重。 */
	messageId?: string;
	senderId: string;
	senderName: string;
	/** 已渲染的可读文本（非文本段给 [图片] 这类占位）。 */
	text: string;
	/** 消息时间（epoch ms）。 */
	timeMs: number;
	/** 是否机器人自己的发言。 */
	self: boolean;
	/** 本地记录顺序（远端条目为 0）：同一秒内的先后排序用。 */
	seq: number;
}

export interface HistoryReadResult {
	entries: ChatHistoryEntry[];
	/** 本地缓冲贡献的条数（未去重、未截断）。 */
	localCount: number;
	/** 远端历史贡献的条数（未去重、未截断）。 */
	remoteCount: number;
}

export interface ChatHistoryDeps {
	api: Pick<OneBotApi, 'getGroupMsgHistory' | 'getFriendMsgHistory'>;
	config: DshQQConfig;
	logger: Logger;
	getSelfId: () => string;
	/** 群成员名解析（只查缓存、不发网络）：把文本里的 @12345 渲染成 @张三(12345)。 */
	nameOf?: (groupId: string, userId: string) => string | undefined;
}

/** 模型未指定 count 时的默认读取条数。 */
export const HISTORY_DEFAULT_COUNT = 20;
/** 本地缓冲最多跟踪的会话数（超出按最久未活跃淘汰，避免多群部署内存无界）。 */
export const HISTORY_MAX_CHATS = 200;
/** 单条记录保留的文本长度（超长截断，避免一条长文刷爆缓冲与 token）。 */
export const MAX_ENTRY_CHARS = 500;
/** 一次读取返回的正文总长度上限（超出从最旧的开始省略）。 */
export const TRANSCRIPT_MAX_CHARS = 6000;

interface ChatBuffer {
	chatType: ChatType;
	chatId: string;
	entries: ChatHistoryEntry[];
	touchedAt: number;
}

function textOf(segments: OBSegment[], fallback: string): string {
	const text = segmentsToText(segments).trim();
	if (text === '') return fallback;
	return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text;
}

function segmentsOfResult(item: MsgResult): OBSegment[] {
	if (Array.isArray(item.message)) return (item.message as OBSegment[]).filter((segment) => segment?.type !== 'reply');
	if (typeof item.raw_message === 'string' && item.raw_message !== '') return parseCQ(item.raw_message).filter((segment) => segment.type !== 'reply');
	if (typeof item.message === 'string' && item.message !== '') return parseCQ(item.message).filter((segment) => segment.type !== 'reply');
	return [];
}

/**
 * 远端历史统一为"旧 → 新"。各实现对返回顺序没有约定（有的最新在前），
 * 这里用 message_seq（全都有时）或 time 判断一次单调性，必要时整体反转；
 * 判不出来就保持原样（顺序由调用方的稳定排序兜底）。
 */
export function orderRemoteOldestFirst(items: readonly MsgResult[]): MsgResult[] {
	const seqs = items.map((item) => (typeof item.message_seq === 'number' && Number.isFinite(item.message_seq) ? item.message_seq : undefined));
	const times = items.map((item) => (typeof item.time === 'number' && Number.isFinite(item.time) ? item.time : undefined));
	const scores = seqs.every((value): value is number => value !== undefined)
		? seqs
		: times.every((value): value is number => value !== undefined)
			? times
			: undefined;
	const first = scores?.[0];
	const last = scores?.[scores.length - 1];
	if (first !== undefined && last !== undefined && first > last) return [...items].reverse();
	return [...items];
}

/** 本地 + 远端合并：按 message_id 去重（本地优先）、按时间正序、截取最新 count 条。 */
export function mergeHistory(
	local: readonly ChatHistoryEntry[],
	remote: readonly ChatHistoryEntry[],
	count: number,
): ChatHistoryEntry[] {
	const merged = new Map<string, ChatHistoryEntry>();
	let anonymous = 0;
	const put = (entry: ChatHistoryEntry, overwrite: boolean): void => {
		const key = entry.messageId !== undefined && entry.messageId !== '' ? `id:${entry.messageId}` : `anon:${anonymous++}`;
		if (overwrite || !merged.has(key)) merged.set(key, entry);
	};
	for (const entry of remote) put(entry, false);
	// 本地条目文本更全（实时渲染 + 媒体占位），同 id 时覆盖远端条目。
	for (const entry of local) put(entry, true);
	const all = [...merged.values()].sort((a, b) => a.timeMs - b.timeMs || a.seq - b.seq);
	const limit = Math.max(1, Math.trunc(count));
	return all.length > limit ? all.slice(all.length - limit) : all;
}

/** 记录里的时间戳：当天只给时刻，跨天带上月日。 */
export function formatEntryTime(timeMs: number, now: number = Date.now()): string {
	const date = new Date(timeMs);
	const pad = (value: number): string => String(value).padStart(2, '0');
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return new Date(now).toDateString() === date.toDateString() ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

export interface TranscriptOptions {
	/** 会话称呼（如「群 888」「好友 12345」）。 */
	chatLabel: string;
	/** 群成员名解析（只查缓存）：把文本里的 @12345 渲染成 @张三（不带号码）。 */
	nameOf?: (userId: string) => string | undefined;
	now?: number;
	maxChars?: number;
}

/**
 * 把记录渲染成给模型看的正文（纯函数，便于测试）。
 *
 * **不渲染 QQ 号**：说话人只给昵称，@ 提及只重写成 @昵称，否则模型回复时会
 * 照抄号码（用户明确要求机器人不要在群里输出别人的 QQ 号）。
 */
export function renderTranscript(entries: readonly ChatHistoryEntry[], options: TranscriptOptions): string {
	const now = options.now ?? Date.now();
	const maxChars = options.maxChars ?? TRANSCRIPT_MAX_CHARS;
	if (entries.length === 0) {
		return `（${options.chatLabel}没有可读取的聊天记录：机器人刚启动，或本会话此前没有消息）`;
	}
	const renderMentions = (text: string): string =>
		options.nameOf === undefined
			? text
			: text.replace(/@(\d{5,11})/g, (token, userId: string) => {
					const name = options.nameOf?.(userId);
					return name === undefined || name === '' ? token : `@${name}`;
				});
	const lines = entries.map((entry) => {
		const who = entry.senderName !== '' ? entry.senderName : entry.senderId;
		const text = renderMentions(entry.text);
		return `[${formatEntryTime(entry.timeMs, now)}] ${who}${entry.self ? '【你】' : ''}：${text}`;
	});
	// 超长从最旧的开始省略：模型要的是"刚才在聊什么"，最新的消息最有用。
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!;
		if (kept.length > 0 && used + line.length + 1 > maxChars) break;
		kept.unshift(line);
		used += line.length + 1;
	}
	const omitted = lines.length - kept.length;
	const header = `【聊天记录】${options.chatLabel}最近 ${kept.length} 条消息（时间正序，最后一条最新；【你】= 机器人自己发的，[图片] 这类是消息段占位；说话人只给昵称，不要在回复里写 QQ 号）：`;
	const footer = omitted > 0 ? `\n（更早的 ${omitted} 条因长度上限已省略）` : '';
	return `${header}\n${kept.join('\n')}${footer}`;
}

export class ChatHistoryService {
	private readonly buffers = new Map<string, ChatBuffer>();
	private seq = 0;

	constructor(private readonly deps: ChatHistoryDeps) {}

	/** 聊天记录能力是否开启（关 = 不记录、工具也不注册）。 */
	get enabled(): boolean {
		return this.deps.config.historyEnabled;
	}

	/** 当前跟踪的会话数与总条数（诊断用）。 */
	get stats(): { chats: number; entries: number } {
		let entries = 0;
		for (const buffer of this.buffers.values()) entries += buffer.entries.length;
		return { chats: this.buffers.size, entries };
	}

	private cap(): number {
		const raw = Math.trunc(this.deps.config.historyBufferPerChat);
		return Number.isFinite(raw) && raw > 0 ? raw : 0;
	}

	private keyOf(chatType: ChatType, chatId: string): string {
		return `${chatType}:${chatId}`;
	}

	/**
	 * 记录一条入站消息（含机器人自己的）。未启用、缓冲上限为 0、
	 * 或同 message_id 已在缓冲里（重复投递）时静默跳过。
	 */
	recordMessage(msg: InboundMessage): void {
		if (!this.enabled) return;
		const cap = this.cap();
		if (cap === 0) return;
		const selfId = this.deps.getSelfId();
		const messageId = msg.messageId !== undefined ? String(msg.messageId) : undefined;
		const key = this.keyOf(msg.chatType, msg.chatId);
		let buffer = this.buffers.get(key);
		if (buffer === undefined) {
			buffer = { chatType: msg.chatType, chatId: msg.chatId, entries: [], touchedAt: Date.now() };
			this.buffers.set(key, buffer);
		}
		buffer.touchedAt = Date.now();
		if (messageId !== undefined && buffer.entries.some((entry) => entry.messageId === messageId)) return;
		buffer.entries.push({
			chatType: msg.chatType,
			chatId: msg.chatId,
			messageId,
			senderId: msg.senderId,
			senderName: msg.senderName !== '' ? msg.senderName : msg.senderId,
			text: textOf(msg.segments, msg.hasImage ? '[图片]' : '（无内容）'),
			timeMs: (typeof msg.time === 'number' && msg.time > 0 ? msg.time : Math.floor(Date.now() / 1000)) * 1000,
			self: selfId !== '' && msg.senderId === selfId,
			seq: ++this.seq,
		});
		if (buffer.entries.length > cap) buffer.entries.splice(0, buffer.entries.length - cap);
		this.evictOldChats();
	}

	/** 超出会话数上限时淘汰最久未活跃的会话缓冲。 */
	private evictOldChats(): void {
		if (this.buffers.size <= HISTORY_MAX_CHATS) return;
		const oldest = [...this.buffers.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(0, this.buffers.size - HISTORY_MAX_CHATS);
		for (const [key] of oldest) this.buffers.delete(key);
	}

	/** 某会话的本地缓冲（旧 → 新；最多 count 条）。 */
	local(chatType: ChatType, chatId: string, count: number): ChatHistoryEntry[] {
		const buffer = this.buffers.get(this.keyOf(chatType, chatId));
		if (buffer === undefined) return [];
		const limit = Math.max(1, Math.trunc(count));
		return buffer.entries.length > limit ? buffer.entries.slice(buffer.entries.length - limit) : [...buffer.entries];
	}

	/**
	 * 读取某会话最近的聊天记录：本地缓冲 + 远端历史（可关）合并去重后
	 * 取最新 count 条（count 被 historyMaxMessages 夹住）。
	 */
	async read(input: { chatType: ChatType; chatId: string; count?: number }): Promise<HistoryReadResult> {
		const max = Math.max(1, Math.trunc(this.deps.config.historyMaxMessages));
		const count = Math.min(Math.max(Math.trunc(input.count ?? HISTORY_DEFAULT_COUNT) || HISTORY_DEFAULT_COUNT, 1), max);
		const local = this.local(input.chatType, input.chatId, count);
		const remote = this.deps.config.historyRemoteFetch ? await this.fetchRemote(input.chatType, input.chatId, count) : [];
		return { entries: mergeHistory(local, remote, count), localCount: local.length, remoteCount: remote.length };
	}

	/** 远端历史；失败/不支持返回空数组（绝不抛错，调用方只看有没有内容）。 */
	private async fetchRemote(chatType: ChatType, chatId: string, count: number): Promise<ChatHistoryEntry[]> {
		let raw: MsgResult[] | undefined;
		try {
			raw = chatType === 'group'
				? await this.deps.api.getGroupMsgHistory(chatId, count)
				: await this.deps.api.getFriendMsgHistory(chatId, count);
		} catch (error) {
			this.deps.logger.warn(`dsh-qq-bot: 读取远端聊天记录失败(${chatType} ${chatId}): ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
		if (raw === undefined || raw.length === 0) return [];
		const selfId = this.deps.getSelfId();
		return orderRemoteOldestFirst(raw).map((item) => {
			const senderId = item.sender?.user_id !== undefined ? String(item.sender.user_id) : '';
			const senderName = String(item.sender?.card ?? '') || String(item.sender?.nickname ?? '') || senderId;
			return {
				chatType,
				chatId,
				messageId: item.message_id !== undefined ? String(item.message_id) : undefined,
				senderId,
				senderName,
				text: textOf(segmentsOfResult(item), '（无内容）'),
				timeMs: (typeof item.time === 'number' && item.time > 0 ? item.time : Math.floor(Date.now() / 1000)) * 1000,
				self: selfId !== '' && senderId === selfId,
				seq: 0,
			};
		});
	}

	/** WebUI 热应用：缓冲上限调小/关闭时立即裁剪（开关本身实时读取）。 */
	reconfigure(): void {
		const cap = this.cap();
		if (cap === 0) {
			this.buffers.clear();
			return;
		}
		for (const buffer of this.buffers.values()) {
			if (buffer.entries.length > cap) buffer.entries.splice(0, buffer.entries.length - cap);
		}
	}
}
