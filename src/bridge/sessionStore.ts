/**
 * QQ 会话身份表：chatKey → 当前 dsh sessionId。
 *
 * dsh 的会话 id 与 cwd 一样「创建即定」：同一个 chatKey 换过会话之后
 * （/reset、写句柄冲突轮换、/cwd 切换），必须持久记住新 id，否则重启
 * 后读不到就回退到基础 id，而基础 id 的会话 cwd 早已过期——表现为
 * "机器人悄悄用回几天前的旧会话，且 WebUI 分组里看不到当前会话"。
 *
 * 因此这张表存在**插件 dataDir**（<dataDir>/chat-sessions.json），而不是
 * 会话工作目录里：工作目录是媒体落盘目录，用户随手清理整个 qq-chats 就
 * 会把身份丢掉（旧版正是这么丢的，见 LEGACY_SESSION_MARKER 注释）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../types.ts';

/**
 * 旧版标记文件名：`<workspaceDir>/.dsh-qq-bot-session`。
 * 只做一次性迁移读取，不再写入；新会话身份一律进 ChatSessionStore。
 */
export const LEGACY_SESSION_MARKER = '.dsh-qq-bot-session';

/** 旧版标记文件路径（迁移排查用）。 */
export function legacySessionMarkerPath(workspaceDir: string): string {
	return join(workspaceDir, LEGACY_SESSION_MARKER);
}

/**
 * 读旧版标记；文件缺失（工作目录被清理过）或为空返回 undefined，
 * 由调用方回退到基础 sessionId。
 */
export function readLegacySessionMarker(workspaceDir: string): string | undefined {
	try {
		const persisted = readFileSync(legacySessionMarkerPath(workspaceDir), 'utf8').trim();
		return persisted === '' ? undefined : persisted;
	} catch {
		return undefined;
	}
}

export class ChatSessionStore {
	private readonly ids = new Map<string, string>();

	private constructor(
		private readonly filePath: string,
		private readonly logger: Logger | undefined,
	) {}

	/** 从 dataDir 加载；文件缺失或损坏视为空表（不阻塞启动）。 */
	static load(dataDir: string, logger?: Logger): ChatSessionStore {
		const filePath = join(dataDir, 'chat-sessions.json');
		const store = new ChatSessionStore(filePath, logger);
		try {
			const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
			for (const [key, value] of Object.entries(raw)) {
				if (typeof value === 'string' && value !== '') store.ids.set(key, value);
			}
		} catch {
			// 首次运行或文件损坏：空表。
		}
		return store;
	}

	get(key: string): string | undefined {
		return this.ids.get(key);
	}

	/** 身份表里的全部 chatKey（启动预热按它遍历；顺序无关）。 */
	keys(): string[] {
		return [...this.ids.keys()];
	}

	set(key: string, sessionId: string): void {
		if (this.ids.get(key) === sessionId) return;
		this.ids.set(key, sessionId);
		this.save();
	}

	private save(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.ids), null, '\t'), 'utf8');
		} catch (error) {
			this.logger?.warn(`dsh-qq-bot: 写会话身份表失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
