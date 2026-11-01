/**
 * 主线程的 RAG worker 客户端。
 *
 * - 请求/响应带 id + 超时；超时返回空（记忆不是关键路径，不能拖住回复）；
 * - worker 崩溃按 1s/5s/15s 重启 3 次，期间保留最近 200 条写入用于重放；
 * - `record` 是 fire-and-forget；`search` 有超时。
 */

import { Worker } from 'node:worker_threads';
import type { Logger } from '../../types.ts';
import type { RagChunkHit, RagProgress, RagRecord, RagSkill, RagStatus, RagWorkerConfig, SkillDraft } from './types.ts';

export interface RagClientOptions {
	dataDir: string;
	runtimeDir: string;
	modelsDir: string;
	vecPath?: string;
	config: RagWorkerConfig;
	logger: Logger;
	onStatus?: (status: RagStatus) => void;
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
	onProgress?: (progress: RagProgress) => void;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_STATUS: RagStatus = {
	ready: false,
	db: false,
	fts: false,
	vec: false,
	embed: false,
	rerank: false,
	runtime: 'missing',
	model: 'missing',
	messages: 0,
	chunks: 0,
	skills: 0,
};

export class RagClient {
	private worker: Worker | undefined;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private status: RagStatus = { ...DEFAULT_STATUS };
	private progress: RagProgress | undefined;
	private started = false;
	private closed = false;
	private restartAttempts = 0;
	private readonly recentRecords: RagRecord[] = [];
	private readonly queue: RagRecord[] = [];

	constructor(private readonly options: RagClientOptions) {}

	get currentStatus(): RagStatus {
		return { ...this.status, ...(this.progress !== undefined ? { progress: this.progress } : {}) };
	}

	get ready(): boolean {
		return this.started && this.status.ready;
	}

	async start(): Promise<void> {
		if (this.closed) return;
		this.started = true;
		await this.spawn();
	}

	private async spawn(): Promise<void> {
		try {
			this.worker = new Worker(new URL('./worker.js', import.meta.url), { execArgv: [] });
		} catch (error) {
			this.options.logger.warn(`dsh-qq-bot: RAG worker 创建失败：${error instanceof Error ? error.message : String(error)}`);
			this.started = false;
			return;
		}
		const worker = this.worker;
		this.progress = undefined;
		worker.on('message', (message: unknown) => this.onMessage(message));
		worker.on('error', error => {
			this.options.logger.warn(`dsh-qq-bot: RAG worker 错误：${error instanceof Error ? error.message : String(error)}`);
		});
		worker.on('exit', code => {
			this.worker = undefined;
			this.started = false;
			for (const [, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`RAG worker 已退出（code=${code}）`));
			}
			this.pending.clear();
			if (this.closed) return;
			this.scheduleRestart(code);
		});
		try {
			await this.request(
				'init',
				{
					dataDir: this.options.dataDir,
					runtimeDir: this.options.runtimeDir,
					modelsDir: this.options.modelsDir,
					...(this.options.vecPath !== undefined ? { vecPath: this.options.vecPath } : {}),
					config: this.options.config,
				},
				60_000,
			);
			this.restartAttempts = 0;
			// 重放最近写入（worker 崩溃/重启期间不丢最近 200 条）。
			for (const record of this.recentRecords.slice(-200)) this.sendRecord(record);
		} catch (error) {
			this.options.logger.warn(`dsh-qq-bot: RAG worker 初始化失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private scheduleRestart(code: number): void {
		if (this.restartAttempts >= 3) {
			this.options.logger.error(`dsh-qq-bot: RAG worker 连续退出（code=${code}），长期记忆停用；重启 dsh 可恢复`);
			this.status = { ...this.status, ready: false, lastError: `worker 连续退出（code=${code}）` };
			this.options.onStatus?.(this.status);
			return;
		}
		const delay = [1000, 5000, 15_000][this.restartAttempts] ?? 15_000;
		this.restartAttempts += 1;
		this.options.logger.warn(`dsh-qq-bot: RAG worker 退出（code=${code}），${delay}ms 后重启（第 ${this.restartAttempts} 次）`);
		setTimeout(() => {
			if (!this.closed) void this.spawn();
		}, delay);
	}

	private onMessage(message: unknown): void {
		if (message === null || typeof message !== 'object') return;
		const record = message as Record<string, unknown>;
		if (record.event === 'status' && record.status !== null && typeof record.status === 'object') {
			this.status = record.status as RagStatus;
			if (this.status.model === 'ready' || this.status.model === 'error') this.progress = undefined;
			this.options.onStatus?.(this.currentStatus);
			return;
		}
		if (record.event === 'log') {
			const level = record.level === 'warn' || record.level === 'error' ? record.level : 'info';
			const text = typeof record.message === 'string' ? record.message : '';
			if (text !== '') this.options.onLog?.(level, text);
			return;
		}
		if (record.event === 'progress' && record.progress !== null && typeof record.progress === 'object') {
			const progress = record.progress as RagProgress;
			if (typeof progress.at !== 'number') progress.at = Date.now();
			this.progress = progress;
			this.options.onProgress?.(progress);
			return;
		}
		const id = typeof record.id === 'number' ? record.id : 0;
		const pending = this.pending.get(id);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (record.ok === true) pending.resolve(record.value);
		else pending.reject(new Error(typeof record.error === 'string' ? record.error : 'RAG worker 请求失败'));
	}

	private request(method: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		const worker = this.worker;
		if (worker === undefined) return Promise.reject(new Error('RAG worker 未启动'));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RAG worker 请求超时（${method}，${timeoutMs}ms）`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				worker.postMessage({ id, method, ...payload });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	record(record: RagRecord): void {
		this.recentRecords.push(record);
		if (this.recentRecords.length > 200) this.recentRecords.splice(0, this.recentRecords.length - 200);
		if (!this.ready) {
			this.queue.push(record);
			if (this.queue.length > 1000) this.queue.shift();
			return;
		}
		this.sendRecord(record);
	}

	private sendRecord(record: RagRecord): void {
		const worker = this.worker;
		if (worker === undefined) return;
		try {
			worker.postMessage({ id: 0, method: 'record', event: record });
		} catch {
			// worker 已退出；recentRecords 会在重启后重放
		}
	}

	async search(chatKey: string, query: string, limit: number): Promise<RagChunkHit[]> {
		if (!this.ready) return [];
		try {
			const value = (await this.request(
				'search',
				{ chatKey, query, limit },
				this.options.config.memoryWorkerSearchTimeoutMs,
			)) as { hits?: RagChunkHit[] } | undefined;
			return Array.isArray(value?.hits) ? value.hits : [];
		} catch (error) {
			this.options.logger.warn(`dsh-qq-bot: RAG 检索失败（本轮跳过）：${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	async recent(chatKey: string, limit: number): Promise<RagChunkHit[]> {
		if (!this.ready) return [];
		try {
			const value = (await this.request('recent', { chatKey, limit }, 5000)) as { hits?: RagChunkHit[] } | undefined;
			return Array.isArray(value?.hits) ? value.hits : [];
		} catch {
			return [];
		}
	}

	async deleteChunk(chunkId: number): Promise<boolean> {
		if (!this.ready) return false;
		try {
			const value = (await this.request('chunks/delete', { chunkId }, 5000)) as { deleted?: boolean } | undefined;
			return value?.deleted === true;
		} catch {
			return false;
		}
	}

	async searchSkills(chatKey: string, query: string, limit: number): Promise<RagSkill[]> {
		if (!this.ready) return [];
		try {
			const value = (await this.request(
				'skills/search',
				{ chatKey, query, limit },
				this.options.config.memoryWorkerSearchTimeoutMs,
			)) as { skills?: RagSkill[] } | undefined;
			return Array.isArray(value?.skills) ? value.skills : [];
		} catch {
			return [];
		}
	}

	async upsertSkill(skill: SkillDraft): Promise<RagSkill | undefined> {
		if (!this.ready) return undefined;
		try {
			const value = (await this.request('skills/upsert', { skill }, 10_000)) as { skill?: RagSkill | null } | undefined;
			return value?.skill ?? undefined;
		} catch (error) {
			this.options.logger.warn(`dsh-qq-bot: 技能写入失败：${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async getSkill(chatKey: string, name: string): Promise<RagSkill | undefined> {
		if (!this.ready) return undefined;
		try {
			const value = (await this.request('skills/get', { chatKey, name }, 5000)) as { skill?: RagSkill | null } | undefined;
			return value?.skill ?? undefined;
		} catch {
			return undefined;
		}
	}

	async listSkills(chatKey: string, includeInactive = false): Promise<RagSkill[]> {
		if (!this.ready) return [];
		try {
			const value = (await this.request('skills/list', { chatKey, includeInactive }, 5000)) as { skills?: RagSkill[] } | undefined;
			return Array.isArray(value?.skills) ? value.skills : [];
		} catch {
			return [];
		}
	}

	async deleteSkill(chatKey: string, skillId: number, actor: string): Promise<boolean> {
		if (!this.ready) return false;
		try {
			const value = (await this.request('skills/delete', { chatKey, skillId, actor }, 5000)) as { deleted?: boolean } | undefined;
			return value?.deleted === true;
		} catch {
			return false;
		}
	}

	async toggleSkill(skillId: number, status: RagSkill['status']): Promise<boolean> {
		if (!this.ready) return false;
		try {
			const value = (await this.request('skills/toggle', { skillId, status }, 5000)) as { changed?: boolean } | undefined;
			return value?.changed === true;
		} catch {
			return false;
		}
	}

	async isSkillTombstoned(
		chatKey: string,
		name: string,
		description: string,
		whenToUse: string,
		body: string,
	): Promise<boolean> {
		if (!this.ready) return false;
		try {
			const value = (await this.request(
				'skills/tombstoned',
				{ chatKey, name, description, whenToUse, body },
				3000,
			)) as { hit?: boolean } | undefined;
			return value?.hit === true;
		} catch {
			return false;
		}
	}

	async promoteSkill(chatKey: string, skillId: number): Promise<RagSkill | undefined> {
		if (!this.ready) return undefined;
		try {
			const value = (await this.request('skills/promote', { chatKey, skillId }, 10_000)) as { skill?: RagSkill | null } | undefined;
			return value?.skill ?? undefined;
		} catch {
			return undefined;
		}
	}

	async stats(): Promise<RagStatus | undefined> {
		if (!this.ready) return this.currentStatus;
		try {
			const status = (await this.request('stats', {}, 3000)) as RagStatus;
			return { ...status, ...(this.progress !== undefined ? { progress: this.progress } : {}) };
		} catch {
			return this.currentStatus;
		}
	}

	async prune(): Promise<number> {
		if (!this.ready) return 0;
		try {
			const value = (await this.request('prune', {}, 30_000)) as { removed?: number } | undefined;
			return typeof value?.removed === 'number' ? value.removed : 0;
		} catch {
			return 0;
		}
	}

	async reindex(chatKey?: string): Promise<number> {
		if (!this.ready) return 0;
		try {
			const value = (await this.request('reindex', { ...(chatKey !== undefined ? { chatKey } : {}) }, 60_000)) as
				| { removed?: number }
				| undefined;
			return typeof value?.removed === 'number' ? value.removed : 0;
		} catch {
			return 0;
		}
	}

	async dispose(): Promise<void> {
		this.closed = true;
		this.started = false;
		const worker = this.worker;
		this.worker = undefined;
		if (worker === undefined) return;
		try {
			worker.postMessage({ id: this.nextId++, method: 'shutdown' });
		} catch {
			// ignore
		}
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => resolve(), 1000);
			worker.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			try {
				void worker.terminate().finally(() => resolve());
			} catch {
				resolve();
			}
		});
	}
}
