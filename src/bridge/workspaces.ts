/**
 * 会话工作目录覆盖（/cwd 命令持久化）。
 *
 * dsh 内核的会话 cwd 创建后不可变，所以"切换工作目录"由插件侧记录覆盖：
 * chatKey → 绝对路径，存 <dataDir>/workspaces.json，重启后恢复。
 * ChatBridgeManager 按"覆盖 > workspaceMode > 默认隔离工作区"的顺序
 * 决定 agent 的 meta.cwd。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../types.ts';

export class WorkspaceOverrides {
	private readonly overrides = new Map<string, string>();

	private constructor(
		private readonly filePath: string,
		private readonly logger: Logger | undefined,
	) {}

	/** 从 dataDir 加载；文件缺失或损坏视为空表（不阻塞启动）。 */
	static load(dataDir: string, logger?: Logger): WorkspaceOverrides {
		const filePath = join(dataDir, 'workspaces.json');
		const store = new WorkspaceOverrides(filePath, logger);
		try {
			const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
			for (const [key, value] of Object.entries(raw)) {
				if (typeof value === 'string' && value !== '') store.overrides.set(key, value);
			}
		} catch {
			// 首次运行或文件损坏：空表。
		}
		return store;
	}

	get(key: string): string | undefined {
		return this.overrides.get(key);
	}

	set(key: string, cwd: string): void {
		this.overrides.set(key, cwd);
		this.save();
	}

	clear(key: string): void {
		if (!this.overrides.delete(key)) return;
		this.save();
	}

	private save(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.overrides), null, '\t'), 'utf8');
		} catch (error) {
			this.logger?.warn(`dsh-qq-bot: 写工作目录覆盖失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
