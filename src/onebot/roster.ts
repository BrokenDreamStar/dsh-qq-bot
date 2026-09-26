/**
 * 群成员列表：让 agent 分清"谁是谁"。
 *
 * 三条能力：
 *  1. 全量成员缓存（get_group_member_list，TTL 刷新 + 单飞 + 落盘）；
 *  2. 名字解析：@12345 → @张三；缓存未命中时单查
 *     get_group_member_info 回填；
 *  3. system prompt section 文本（只列自己/管理员/最近发言人，
 *     上限 rosterMaxMembers，避免大群刷爆 token）。
 *
 * **号码不出现在模型可见文本里**（用户明确要求：机器人在群里提人时不要输出
 * QQ 号）：成员列表只给昵称，@ 提及只重写成 @昵称，纪律提示也明确禁止写号码。
 * 号码只在插件内部（缓存键、chatKey、工具权限）使用。
 *
 * section 通过 PromptSection 的动态 text provider 注入——setupAgent
 * 注册一次，每次组 prompt 时求值，永不过期；求值只用缓存不发网络，
 * 刷新由消息事件驱动（touchGroup）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshQQConfig } from '../config.ts';
import type { GroupMemberListInfo, OneBotApi } from './api.ts';
import type { Logger } from '../types.ts';

export interface RosterDeps {
	api: Pick<OneBotApi, 'getGroupMemberList' | 'getGroupMemberInfo'>;
	config: DshQQConfig;
	logger: Logger;
	dataDir: string;
	getSelfId: () => string;
}

interface MemberEntry {
	userId: string;
	/** 群名片 || 昵称（拉取时已归一）。 */
	name: string;
	role?: string;
}

interface GroupState {
	fetchedAt: number;
	members: Map<string, MemberEntry>;
	/** 最近发言人活跃时间（易失；用于 section 优先级排序）。 */
	lastActive: Map<string, number>;
	inflight: Promise<void> | null;
}

interface PersistedRoster {
	fetchedAt: number;
	members: Array<{ userId: string; card?: string; nickname?: string; role?: string }>;
}

const RECENT_CAP = 300;

export class RosterService {
	private readonly groups = new Map<string, GroupState>();
	private readonly dir: string;

	constructor(private readonly deps: RosterDeps) {
		this.dir = join(deps.dataDir, 'roster');
		try {
			mkdirSync(this.dir, { recursive: true });
		} catch {
			// 读写失败在具体操作时再暴露
		}
	}

	private pathFor(groupId: string): string {
		return join(this.dir, `${groupId}.json`);
	}

	private stateFor(groupId: string): GroupState {
		let state = this.groups.get(groupId);
		if (state === undefined) {
			state = { fetchedAt: 0, members: new Map(), lastActive: new Map(), inflight: null };
			this.load(state, groupId);
			this.groups.set(groupId, state);
		}
		return state;
	}

	private load(state: GroupState, groupId: string): void {
		const path = this.pathFor(groupId);
		if (!existsSync(path)) return;
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedRoster;
			state.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
			for (const member of parsed.members ?? []) {
				state.members.set(String(member.userId), {
					userId: String(member.userId),
					name: String(member.card ?? '') || String(member.nickname ?? '') || String(member.userId),
					role: member.role,
				});
			}
		} catch (error) {
			this.deps.logger.warn(`dsh-qq-bot: 群成员列表缓存读取失败(群 ${groupId}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private persist(state: GroupState, groupId: string): void {
		const payload: PersistedRoster = {
			fetchedAt: state.fetchedAt,
			members: [...state.members.values()].map((member) => ({ userId: member.userId, card: member.name, role: member.role })),
		};
		try {
			writeFileSync(this.pathFor(groupId), JSON.stringify(payload), 'utf8');
		} catch (error) {
			this.deps.logger.warn(`dsh-qq-bot: 群成员列表缓存写入失败(群 ${groupId}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * 记录群消息活跃度并保证成员列表新鲜；刷新在后台进行，绝不阻塞消息链路。
	 * 所有过了访问控制的群消息都应调用（不只是唤醒消息）。
	 */
	touchGroup(groupId: string, senderId: string): void {
		if (!this.deps.config.rosterEnabled) return;
		const state = this.stateFor(groupId);
		state.lastActive.set(String(senderId), Date.now());
		if (state.lastActive.size > RECENT_CAP) {
			const keep = [...state.lastActive.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.floor(RECENT_CAP / 2));
			state.lastActive = new Map(keep);
		}
		void this.ensureFresh(groupId, state);
	}

	private isStale(state: GroupState): boolean {
		return Date.now() - state.fetchedAt > this.deps.config.rosterTtlMs;
	}

	private ensureFresh(groupId: string, state: GroupState): Promise<void> {
		if (!this.isStale(state)) return Promise.resolve();
		if (state.inflight !== null) return state.inflight;
		state.inflight = (async () => {
			const list: GroupMemberListInfo[] | undefined = await this.deps.api.getGroupMemberList(groupId);
			if (list !== undefined && list.length > 0) {
				const members = new Map<string, MemberEntry>();
				for (const member of list) {
					members.set(member.user_id, {
						userId: member.user_id,
						name: member.card !== '' ? member.card : member.nickname !== '' ? member.nickname : member.user_id,
						role: member.role,
					});
				}
				state.members = members;
				state.fetchedAt = Date.now();
				this.persist(state, groupId);
				this.deps.logger.info(`dsh-qq-bot: 群 ${groupId} 成员列表已刷新（${members.size} 人）`);
			} else if (list !== undefined) {
				// 空结果也计入 TTL，避免死群反复拉取。
				state.fetchedAt = Date.now();
			}
		})()
			.catch((error: unknown) => {
				this.deps.logger.warn(`dsh-qq-bot: 群成员列表获取失败(群 ${groupId}): ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				state.inflight = null;
			});
		return state.inflight;
	}

	/**
	 * 单人名字解析：缓存命中直接返回；未命中时单查
	 * get_group_member_info 并回填缓存（用于 @提及渲染）。
	 */
	async nameFor(groupId: string, userId: string): Promise<string | undefined> {
		if (!this.deps.config.rosterEnabled) return undefined;
		const state = this.stateFor(groupId);
		const hit = state.members.get(String(userId));
		if (hit !== undefined) return hit.name;
		const info = await this.deps.api.getGroupMemberInfo(groupId, String(userId));
		if (info === undefined) return undefined;
		const entry: MemberEntry = {
			userId: info.user_id,
			name: info.card !== '' ? info.card : info.nickname !== '' ? info.nickname : info.user_id,
			role: info.role,
		};
		state.members.set(entry.userId, entry);
		this.persist(state, groupId);
		return entry.name;
	}

	/**
	 * 已知成员名（**只查缓存，不发网络**）：@提及/聊天记录渲染用。
	 * 缓存不存在时顺带按群装载落盘文件（仍不发网络）；未命中返回 undefined。
	 */
	cachedName(groupId: string, userId: string): string | undefined {
		const state = this.groups.get(groupId) ?? this.stateFor(groupId);
		return state.members.get(String(userId))?.name;
	}

	/**
	 * @提及重写：把文本里的 @12345 换成 @张三。
	 *
	 * **不带号码**：模型看到的每一处提及都只有昵称，回复里就不会出现别人的
	 * QQ 号（用户明确要求，原先渲染为 @张三(12345) 时模型会照抄号码）。
	 * 解析失败或未启用时原样返回（宁可留裸号码，也不编造名字）。
	 */
	async renderMentions(text: string, groupId: string | undefined): Promise<string> {
		if (groupId === undefined || !this.deps.config.rosterEnabled) return text;
		const tokens = text.match(/@\d{5,11}/g);
		if (tokens === null) return text;
		let out = text;
		for (const token of new Set(tokens)) {
			const userId = token.slice(1);
			const name = await this.nameFor(groupId, userId);
			if (name !== undefined) out = out.split(token).join(`@${name}`);
		}
		return out;
	}

	/**
	 * 群成员列表 section 文本（作为 PromptSection 动态 text provider 的返回值）。
	 * 只用内存/磁盘缓存，不发网络；未启用或无数据返回 ''（空 section 会被丢弃）。
	 */
	sectionFor(groupId: string): string {
		if (!this.deps.config.rosterEnabled) return '';
		const state = this.groups.get(groupId);
		if (state === undefined || state.members.size === 0) return '';
		const selfId = this.deps.getSelfId();
		const max = this.deps.config.rosterMaxMembers;

		// 优先级：自己 → 管理员/群主 → 最近发言人 → 其余补足。
		const picked: string[] = [];
		const push = (userId: string): void => {
			if (picked.length < max && !picked.includes(userId) && state.members.has(userId)) picked.push(userId);
		};
		if (selfId !== '') push(selfId);
		for (const member of state.members.values()) {
			if (member.role === 'owner' || member.role === 'admin') push(member.userId);
		}
		const recent = [...state.lastActive.entries()].sort((a, b) => b[1] - a[1]).map(([userId]) => userId);
		for (const userId of recent) push(userId);
		if (picked.length < max) {
			for (const userId of state.members.keys()) {
				if (picked.length >= max) break;
				push(userId);
			}
		}

		const render = (userId: string): string => {
			const entry = state.members.get(userId);
			if (entry === undefined) return '';
			const tags: string[] = [];
			if (entry.role === 'owner') tags.push('群主');
			else if (entry.role === 'admin') tags.push('管理员');
			if (userId === selfId) tags.push('是你自己');
			// 只给昵称：号码不进模型可见文本（否则回复里会照抄 QQ 号）。
			return `${entry.name}${tags.length > 0 ? `（${tags.join('，')}）` : ''}`;
		};

		const listed = picked.map(render).filter((text) => text !== '').join('、');
		const overflow = state.members.size > picked.length ? `……其余 ${state.members.size - picked.length} 人未列出` : '';
		return [
			`【群成员列表】本群共 ${state.members.size} 人，以下是你最可能需要称呼的成员：`,
			`${listed}${overflow}`,
			'用昵称称呼成员。**不要在回复里写出任何人的 QQ 号或群号**——群成员看到的就是一个号码，既没意义也是隐私。',
			'昵称可能重复或变更：分不清对方是谁、或不确定某句话是谁说的时，直接用昵称向对方确认（例如"刚才说的是哪位？"），不要靠猜，也不要向任何人索要号码。',
		].join('\n');
	}
}
