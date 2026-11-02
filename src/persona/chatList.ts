/**
 * 「会话模型设置」的会话下拉选项：把 QQ 侧的群 / 好友清单、本地已有会话目录
 * 与已保存的号码行合并成一份 `group_<群号>` / `friend_<QQ号>` 清单。
 *
 * 用户不该为了配一个模型去手抄群号——号码由插件自己收集，下拉里显示
 * 「群名（群号）」。三个来源各自的边界：
 *  - QQ 清单（`get_group_list` / `get_friend_list`）：唯一能给出**名字**的来源，
 *    但依赖 transport 已连接，且对接端未必支持；失败时静默降级。
 *  - 本地会话目录（`<数据目录>/sessions/Friend_*|Group_*`）：离线可用，覆盖
 *    "聊过天但还没连上 QQ" 的情况，只是没有名字。
 *  - 已保存的号码行：会话目录被删/搬家后仍要能回显，否则保存一次就丢配置。
 *
 * 远端清单缓存 `ttlMs`（默认 30s，一次页面加载 + 一次保存不必打两遍接口）；
 * 本地扫描不缓存——新增会话马上要能在下拉里看到。
 */
import { readdirSync } from 'node:fs';
import type { ChatDirectoryEntry } from '../onebot/api.ts';
import type { Logger } from '../types.ts';
import { formatChatSelector, parseChatSelector } from './routes.ts';

export type ChatKind = 'private' | 'group';

/** 下拉里的一项。`chat` 是表格里回显的选择器（`group_123` / `friend_456`）。 */
export interface ChatOption {
	chat: string;
	kind: ChatKind;
	/** QQ 号 / 群号（纯数字）。 */
	id: string;
	/** 群名 / 好友备注或昵称；来源不知道时省略。 */
	name?: string;
}

export interface ChatListDeps {
	/** 会话目录根（`<数据目录>/sessions`）。 */
	sessionsRoot: string;
	/** 已保存的号码级键（`g-123` / `u-456`）；会话目录被删也要能回显。 */
	savedKeys: () => readonly string[];
	/** QQ 群清单；未连接 / 不支持时返回 undefined。 */
	listGroups?: () => Promise<readonly ChatDirectoryEntry[] | undefined>;
	/** QQ 好友清单；同上。 */
	listFriends?: () => Promise<readonly ChatDirectoryEntry[] | undefined>;
	logger: Logger;
	/** 远端清单缓存时长（ms），默认 30s。 */
	ttlMs?: number;
	now?: () => number;
}

/** 下拉选项上限：好友上千的账号不至于把设置页拖死（群排在前面，先被保留）。 */
const MAX_OPTIONS = 500;
const DEFAULT_TTL_MS = 30_000;

interface RemoteDirectory {
	groups: readonly ChatDirectoryEntry[];
	friends: readonly ChatDirectoryEntry[];
}

export class ChatDirectory {
	private remote: { at: number; directory: RemoteDirectory } | null = null;
	private inflight: Promise<RemoteDirectory> | null = null;

	constructor(private readonly deps: ChatListDeps) {}

	/** 合并后的会话清单（群在前、好友在后，各自按名字/号码排序）。 */
	async list(): Promise<ChatOption[]> {
		const remote = await this.remoteDirectory();
		const options = new Map<string, ChatOption>();
		const add = (chat: string, kind: ChatKind, id: string, name?: string): void => {
			const existing = options.get(chat);
			if (existing === undefined) {
				options.set(chat, { chat, kind, id, ...(name !== undefined && name !== '' ? { name } : {}) });
				return;
			}
			// 后来的来源只补名字，不覆盖已有项（QQ 清单排在前面，名字以它为准）。
			if (existing.name === undefined && name !== undefined && name !== '') existing.name = name;
		};
		for (const group of remote.groups) add(`group_${group.id}`, 'group', group.id, group.name);
		for (const friend of remote.friends) add(`friend_${friend.id}`, 'private', friend.id, friend.name);
		for (const entry of this.sessionDirs()) add(entry.chat, entry.kind, entry.id);
		for (const key of this.deps.savedKeys()) {
			const chat = formatChatSelector(key);
			if (chat === null) continue;
			const selector = parseChatSelector(chat);
			if (selector === null) continue;
			add(chat, selector.scope, selector.chatId);
		}
		return [...options.values()].sort(compareOptions).slice(0, MAX_OPTIONS);
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/** 远端群 / 好友清单：命中缓存直接用，否则并发拉一次（同时只跑一份）。 */
	private async remoteDirectory(): Promise<RemoteDirectory> {
		const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS;
		if (this.remote !== null && this.now() - this.remote.at < ttl) return this.remote.directory;
		if (this.inflight !== null) return this.inflight;
		const task = this.fetchRemote()
			.then((directory) => {
				// 有一边失败就不缓存：下次打开设置页再试，别把空清单钉住 30s。
				if (directory.groups !== undefined && directory.friends !== undefined) {
					this.remote = { at: this.now(), directory: { groups: directory.groups, friends: directory.friends } };
				}
				return { groups: directory.groups ?? [], friends: directory.friends ?? [] };
			})
			.finally(() => {
				if (this.inflight === task) this.inflight = null;
			});
		this.inflight = task;
		return task;
	}

	private async fetchRemote(): Promise<{ groups?: readonly ChatDirectoryEntry[]; friends?: readonly ChatDirectoryEntry[] }> {
		const call = async (
			label: string,
			fetch: (() => Promise<readonly ChatDirectoryEntry[] | undefined>) | undefined,
		): Promise<readonly ChatDirectoryEntry[] | undefined> => {
			if (fetch === undefined) return undefined;
			try {
				return await fetch();
			} catch (error) {
				this.deps.logger.warn(`dsh-qq-bot: 读取${label}清单失败: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		};
		const [groups, friends] = await Promise.all([call('群', this.deps.listGroups), call('好友', this.deps.listFriends)]);
		return { groups, friends };
	}

	/** 本地会话目录（`Friend_123` / `Group_456`）→ 选项；目录不存在返回空表。 */
	private sessionDirs(): Array<{ chat: string; kind: ChatKind; id: string }> {
		let entries: Array<{ name: string; isDirectory: () => boolean }>;
		try {
			entries = readdirSync(this.deps.sessionsRoot, { withFileTypes: true });
		} catch {
			return [];
		}
		const found: Array<{ chat: string; kind: ChatKind; id: string }> = [];
		for (const entry of entries) {
			if (typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
			const match = /^(Friend|Group)_(\d+)$/.exec(entry.name);
			if (match === null) continue;
			const kind: ChatKind = match[1] === 'Friend' ? 'private' : 'group';
			const id = match[2]!;
			found.push({ chat: `${kind === 'private' ? 'friend' : 'group'}_${id}`, kind, id });
		}
		return found;
	}
}

/** 群在前、私聊在后；同类按名字（没有名字的排后面），再按号码。 */
function compareOptions(a: ChatOption, b: ChatOption): number {
	if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
	const left = a.name ?? '';
	const right = b.name ?? '';
	if (left !== right) {
		if (left === '') return 1;
		if (right === '') return -1;
		const byName = left.localeCompare(right, 'zh-Hans-CN');
		if (byName !== 0) return byName;
	}
	return a.id.localeCompare(b.id);
}
