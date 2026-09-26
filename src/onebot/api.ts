/**
 * OneBot action 封装：typed 调用入口（发送/媒体/群信息/请求处理/撤回）。
 */
import type { SendTarget } from '../types.ts';
import type { OneBotTransport } from '../transport/base.ts';
import type { Logger } from '../types.ts';
import { splitText } from '../outbound/chunk.ts';
import type { OBSegment } from './segments.ts';

export interface LoginInfo {
	user_id: string;
	nickname: string;
}

export interface ImageInfo {
	file: string;
	url?: string;
	path?: string;
	file_size?: string | number;
}

export interface GroupMemberInfo {
	user_id: string;
	nickname: string;
	card: string;
	role?: string;
}

export interface MsgResult {
	message_id: number;
	/** 消息序号（历史接口给；同一秒内的先后顺序比时间戳可靠）。 */
	message_seq?: number;
	message?: unknown;
	raw_message?: string;
	sender?: { user_id?: number | string; nickname?: string; card?: string };
	time?: number;
	content?: string;
}

export interface GroupMemberListInfo {
	user_id: string;
	nickname: string;
	card: string;
	role?: string;
}

export interface ForwardNode {
	uin: string;
	name: string;
	content: string;
}

/**
 * 历史接口的消息数组：不同实现返回 `{ messages: [...] }`（OneBot 11 扩展约定）、
 * `{ message: [...] }` 或裸数组，这里统一取出。
 */
function historyList(data: unknown): unknown[] | undefined {
	if (Array.isArray(data)) return data;
	if (data === null || typeof data !== 'object') return undefined;
	const record = data as { messages?: unknown; message?: unknown };
	if (Array.isArray(record.messages)) return record.messages;
	if (Array.isArray(record.message)) return record.message;
	return undefined;
}

export class OneBotApi {
	constructor(
		private transport: OneBotTransport,
		private readonly logger: Logger,
	) {}

	/** 热替换底层传输（WebUI 改连接参数后重建 transport 时用）。 */
	attach(transport: OneBotTransport): void {
		this.transport = transport;
	}

	get connected(): boolean {
		return this.transport.connected;
	}

	/** 原始 action 调用（插件直通 napcat 扩展 API 的逃生口）。 */
	call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
		return this.transport.call(action, params);
	}

	async getLoginInfo(): Promise<LoginInfo | undefined> {
		try {
			const data = (await this.transport.call('get_login_info')) as { user_id?: number | string; nickname?: string } | undefined;
			if (data === undefined || data.user_id === undefined) return undefined;
			return { user_id: String(data.user_id), nickname: String(data.nickname ?? '') };
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: get_login_info failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async getVersion(): Promise<string | undefined> {
		try {
			const data = (await this.transport.call('get_version_info')) as { app_name?: string; app_version?: string } | undefined;
			if (data === undefined) return undefined;
			return `${data.app_name ?? 'OneBot'} ${data.app_version ?? ''}`.trim();
		} catch {
			return undefined;
		}
	}

	/** 发送消息段数组；返回 message_id。 */
	async sendSegments(target: SendTarget, segments: OBSegment[]): Promise<number | null> {
		const params =
			target.chatType === 'group'
				? { group_id: target.groupId, message: segments }
				: { user_id: target.userId, message: segments };
		try {
			const data = (await this.transport.call('send_msg', params)) as { message_id?: number | string } | undefined;
			return data?.message_id !== undefined ? Number(data.message_id) : null;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: send_msg failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** 发送文本（自动按 maxChars 分块）；返回最后一条 message_id。 */
	async sendText(target: SendTarget, text: string, maxChars: number): Promise<number | null> {
		let lastId: number | null = null;
		for (const chunk of splitText(text, maxChars)) {
			const id = await this.sendSegments(target, [{ type: 'text', data: { text: chunk } }]);
			if (id !== null) lastId = id;
		}
		return lastId;
	}

	/** 群合并转发（长文折叠用）。 */
	async sendGroupForward(groupId: string, nodes: ForwardNode[]): Promise<number | null> {
		const segments = nodes.map((node) => ({
			type: 'node',
			data: { uin: node.uin, name: node.name, content: [{ type: 'text', data: { text: node.content } }] },
		}));
		try {
			const data = (await this.transport.call('send_group_forward_msg', { group_id: groupId, messages: segments })) as
				| { message_id?: number | string }
				| undefined;
			return data?.message_id !== undefined ? Number(data.message_id) : null;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: send_group_forward_msg failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** 私聊合并转发。 */
	async sendPrivateForward(userId: string, nodes: ForwardNode[]): Promise<number | null> {
		const segments = nodes.map((node) => ({
			type: 'node',
			data: { uin: node.uin, name: node.name, content: [{ type: 'text', data: { text: node.content } }] },
		}));
		try {
			const data = (await this.transport.call('send_private_forward_msg', { user_id: userId, messages: segments })) as
				| { message_id?: number | string }
				| undefined;
			return data?.message_id !== undefined ? Number(data.message_id) : null;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: send_private_forward_msg failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** 解析图片：napcat 通常直接给 url；同机部署时给本地 path。 */
	async getImage(fileId: string): Promise<ImageInfo | undefined> {
		try {
			const data = (await this.transport.call('get_image', { file: fileId })) as Partial<ImageInfo> | undefined;
			if (data === undefined || (data.url === undefined && data.path === undefined && data.file === undefined)) return undefined;
			return { file: String(data.file ?? fileId), url: data.url, path: data.path, file_size: data.file_size };
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: get_image failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/** 反查一条消息（引用回复还原原文用）。 */
	async getMsg(messageId: string | number): Promise<MsgResult | undefined> {
		try {
			const data = (await this.transport.call('get_msg', { message_id: messageId })) as Partial<MsgResult> | undefined;
			if (data === undefined || data.message_id === undefined) return undefined;
			return {
				message_id: Number(data.message_id),
				message: data.message,
				sender: data.sender,
				time: data.time,
				content: typeof data.content === 'string' ? data.content : undefined,
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * 群聊历史消息（OneBot 11 扩展接口 `get_group_msg_history`，napcat / Lagrange 支持）。
	 * 与插件自己看到的流水不同：它能拿到机器人启动之前、以及未被本插件记录的
	 * 消息；但各实现对可回溯窗口有上限（常见只给最近若干条）。失败返回 undefined，
	 * 调用方回退本地缓存。
	 */
	async getGroupMsgHistory(groupId: string, count: number, messageSeq?: number): Promise<MsgResult[] | undefined> {
		return this.getHistory('get_group_msg_history', { group_id: groupId, count, message_seq: messageSeq ?? 0 });
	}

	/** 私聊历史消息（`get_friend_msg_history`）；对接端不支持时返回 undefined。 */
	async getFriendMsgHistory(userId: string, count: number, messageSeq?: number): Promise<MsgResult[] | undefined> {
		return this.getHistory('get_friend_msg_history', { user_id: userId, count, message_seq: messageSeq ?? 0 });
	}

	/** 历史接口的公共解析：容忍 messages / message / 裸数组三种返回形态。 */
	private async getHistory(action: string, params: Record<string, unknown>): Promise<MsgResult[] | undefined> {
		try {
			const list = historyList(await this.transport.call(action, params));
			if (list === undefined) return undefined;
			return list
				.filter((item): item is Record<string, unknown> => {
					if (item === null || typeof item !== 'object') return false;
					return (item as Record<string, unknown>)['message_id'] !== undefined;
				})
				.map((item) => ({
					message_id: Number(item['message_id']),
					message_seq: item['message_seq'] !== undefined ? Number(item['message_seq']) : undefined,
					message: item['message'],
					raw_message: typeof item['raw_message'] === 'string' ? item['raw_message'] : undefined,
					sender: item['sender'] as MsgResult['sender'],
					time: typeof item['time'] === 'number' ? item['time'] : undefined,
					content: typeof item['content'] === 'string' ? item['content'] : undefined,
				}));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async getGroupMemberInfo(groupId: string, userId: string, noCache = false): Promise<GroupMemberInfo | undefined> {
		try {
			const data = (await this.transport.call('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: noCache })) as
				| { user_id?: number | string; nickname?: string; card?: string; role?: string }
				| undefined;
			if (data === undefined || data.user_id === undefined) return undefined;
			return { user_id: String(data.user_id), nickname: String(data.nickname ?? ''), card: String(data.card ?? ''), role: data.role };
		} catch {
			return undefined;
		}
	}

	/** 全量群成员列表（大群可达数千人，调用方须自行缓存）。 */
	async getGroupMemberList(groupId: string): Promise<GroupMemberListInfo[] | undefined> {
		try {
			const data = (await this.transport.call('get_group_member_list', { group_id: groupId })) as
				| Array<{ user_id?: number | string; nickname?: string; card?: string; role?: string }>
				| undefined;
			if (!Array.isArray(data)) return undefined;
			return data
				.filter((entry) => entry?.user_id !== undefined)
				.map((entry) => ({
					user_id: String(entry.user_id),
					nickname: String(entry.nickname ?? ''),
					card: String(entry.card ?? ''),
					role: entry.role,
				}));
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: get_group_member_list failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async deleteMsg(messageId: string | number): Promise<boolean> {
		try {
			await this.transport.call('delete_msg', { message_id: messageId });
			return true;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: delete_msg failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async setFriendAddRequest(flag: string, approve: boolean, remark?: string): Promise<boolean> {
		try {
			await this.transport.call('set_friend_add_request', { flag, approve, remark });
			return true;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: set_friend_add_request failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async setGroupAddRequest(flag: string, subType: string, approve: boolean, reason?: string): Promise<boolean> {
		try {
			await this.transport.call('set_group_add_request', { flag, sub_type: subType, approve, reason });
			return true;
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: set_group_add_request failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
}
