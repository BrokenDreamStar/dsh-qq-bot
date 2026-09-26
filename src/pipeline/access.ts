/**
 * Pipeline：访问控制（黑/白名单 + 管理员）、限速、消息去重。
 *
 * 安全默认：allowlist 模式下列表为空 = 全部拒绝（与 AstrBot 相反，
 * 见 README 安全章节）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { DshQQConfig } from '../config.ts';
import { resolveAdminFile } from '../paths.ts';
import type { Logger } from '../types.ts';

function listContains(list: string[], id: string): boolean {
	return list.includes(String(id));
}

/** 管理员 = 配置里的 adminUsers ∪ admins.json 文件里的动态条目。 */
export class AdminStore {
	private fileUsers: string[] = [];
	private readonly filePath: string;

	/**
	 * @param dataDir 统一数据目录（见 paths.ts）；文件路径 = 旧 `adminUsersFile`
	 * 有值时沿用它，否则 `<dataDir>/admins.json`。
	 * @param homeDir 仅用于展开旧字段里的 `~`（测试可注入）。
	 */
	constructor(
		private readonly config: DshQQConfig,
		dataDir: string,
		private readonly logger: Logger,
		homeDir: string = homedir(),
	) {
		this.filePath = resolveAdminFile(config, dataDir, homeDir);
	}

	/** 从磁盘加载动态管理员（不存在时视为空）。 */
	async load(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			this.fileUsers = Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			this.fileUsers = [];
		}
	}

	private async persist(): Promise<void> {
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(this.filePath, `${JSON.stringify(this.fileUsers, null, 2)}\n`, 'utf8');
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写管理员文件失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	isAdmin(userId: string): boolean {
		return listContains(this.config.adminUsers, userId) || listContains(this.fileUsers, userId);
	}

	list(): string[] {
		return [...new Set([...this.config.adminUsers.map(String), ...this.fileUsers.map(String)])];
	}

	async add(userId: string): Promise<boolean> {
		if (listContains(this.config.adminUsers, userId)) return false;
		if (listContains(this.fileUsers, userId)) return false;
		this.fileUsers.push(String(userId));
		await this.persist();
		return true;
	}

	async remove(userId: string): Promise<boolean> {
		const index = this.fileUsers.findIndex((id) => id === String(userId));
		if (index < 0) return false;
		this.fileUsers.splice(index, 1);
		await this.persist();
		return true;
	}
}

export type AccessMode = 'allowlist' | 'open' | 'disabled';

export class AccessControl {
	constructor(
		private readonly config: DshQQConfig,
		private readonly admins: AdminStore,
	) {}

	checkPrivate(userId: string): boolean {
		// disabled = 渠道整体关闭，管理员也不例外。
		if (this.config.privateMode === 'disabled') return false;
		if (listContains(this.config.blockedUsers, userId)) return false;
		if (this.admins.isAdmin(userId)) return true;
		return this.check(this.config.privateMode, this.config.allowedUsers, userId);
	}

	checkGroup(groupId: string, userId: string): boolean {
		if (this.config.groupMode === 'disabled') return false;
		if (listContains(this.config.blockedGroups, groupId) || listContains(this.config.blockedUsers, userId)) return false;
		if (this.admins.isAdmin(userId)) return true;
		return this.check(this.config.groupMode, this.config.allowedGroups, groupId);
	}

	private check(mode: AccessMode, allowlist: string[], id: string): boolean {
		if (mode === 'disabled') return false;
		if (mode === 'open') return true;
		// allowlist：空列表 = 全部拒绝（安全默认）。
		return allowlist.length > 0 && listContains(allowlist, id);
	}
}

/** 滑动窗口限速（按会话）。max=0 时禁用（恒放行）。 */
export class RateLimiter {
	private hits = new Map<string, number[]>();

	constructor(
		private windowMs: number,
		private max: number,
	) {}

	/** 热更新限速参数（WebUI 改配置后同步）。 */
	configure(windowMs: number, max: number): void {
		this.windowMs = windowMs;
		this.max = max;
	}

	/** 返回 true = 放行；false = 已超限。 */
	consume(key: string, now = Date.now()): boolean {
		if (this.max <= 0) return true;
		const windowStart = now - this.windowMs;
		const recent = (this.hits.get(key) ?? []).filter((time) => time > windowStart);
		if (recent.length >= this.max) {
			this.hits.set(key, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(key, recent);
		if (this.hits.size > 4096) {
			for (const [k, times] of this.hits) {
				if (times.length === 0 || times[times.length - 1]! <= windowStart) this.hits.delete(k);
			}
		}
		return true;
	}
}

/** message_id 去重（napcat 重连重发保护）。 */
export class MsgDeduper {
	private seen = new Set<string>();
	private order: string[] = [];

	constructor(private readonly capacity = 4096) {}

	checkAndMark(id: string | undefined): boolean {
		if (id === undefined || id === '') return true; // 无 id 视为新消息
		if (this.seen.has(id)) return false;
		this.seen.add(id);
		this.order.push(id);
		while (this.order.length > this.capacity) {
			const oldest = this.order.shift();
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		return true;
	}
}
