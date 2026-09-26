/**
 * 消息日志：内存环形缓冲 + 可选 NDJSON 落盘。
 *
 * 记录三类信息，供 WebUI「消息日志与诊断」卡片内嵌的日志视图（实时流 + 轮询降级）
 * 与 /logs 命令查看：
 *  - onebot/in   来自 OneBot 对接端（napcat）的归一化事件（消息/戳一戳/请求）
 *  - onebot/out  发往对接端的 action（send_msg / 合并转发 / 撤回 / 请求处理）
 *  - dsh/in|out  会话桥送进 dsh 的最终 prompt 与 dsh 的回复原文（分块/折叠前）
 *  - pipeline/sys 管线丢弃原因（访问拒绝、限速、队列满；**群聊被访问控制拒绝时
 *    不记**——收到的消息本身仍有一条 in 记录，见 pipeline/dispatcher）
 *  - search/sys  网页搜索（qq_web_search）：用了哪个后端、多少条来源、顺延原因
 *    （排查 API Key / 额度问题时看这里，见 search/service.ts）
 *
 * record() 恒不抛错、enabled=false 时直接丢弃：日志绝不能影响消息主链路。
 */
import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatType, Logger } from '../types.ts';

/** 条目方向：in = 对接端→插件；out = 插件→对接端；sys = 管线内部判定。 */
export type LogDirection = 'in' | 'out' | 'sys';

/** 条目来源：onebot 对接端 / dsh 会话桥 / pipeline 管线判定 / search 网页搜索。 */
export type LogScope = 'onebot' | 'dsh' | 'pipeline' | 'search';

/** 单条日志。 */
export interface MessageLogEntry {
	/** 单调递增序号（重启归零）。 */
	seq: number;
	/** 记录时间（epoch ms）。 */
	ts: number;
	dir: LogDirection;
	scope: LogScope;
	/** 事件类型：message / poke / friendRequest / groupRequest / send / recall / request / prompt / reply / drop / action-error。 */
	event: string;
	chatType?: ChatType;
	/** 群号或对方 QQ 号。 */
	chatId?: string;
	senderId?: string;
	senderName?: string;
	/** 主要内容（文本预览，已截断）。 */
	text: string;
	/** 附加信息（action 名、message_id、错误原因等）。 */
	detail?: string;
}

/**
 * 订阅事件：WebUI 实时日志视图据此增量更新（见 logs/stream.ts）。
 *  - append 一条新记录（含 seq，客户端据此检测丢帧）
 *  - clear  内存缓冲被清空（/logs clear 或 WebUI「清空」按钮）
 */
export type MessageLogEvent = { kind: 'append'; entry: MessageLogEntry } | { kind: 'clear' };

/** 落盘 NDJSON 单文件大小上限；超过轮转为 .old（覆盖旧轮转）。 */
const FILE_ROTATE_BYTES = 5 * 1024 * 1024;
/** 每条内容的截断长度（单条 QQ 消息约 4500 字符内，dsh 回复可能更长）。 */
const MAX_TEXT_CHARS = 2000;
/** 落盘大小检查的采样间隔（每 N 条查一次 stat，避免每条都 stat）。 */
const ROTATE_CHECK_INTERVAL = 200;

export interface MessageLogOptions {
	logger: Logger;
	dataDir: string;
}

export class MessageLogService {
	private entries: MessageLogEntry[] = [];
	private seq = 0;
	private enabled = true;
	private maxEntries = 500;
	private fileEnabled = false;
	private fileWrittenSinceCheck = 0;
	/** 实时订阅者（WebUI 日志流）；record/clear 同步派发。 */
	private readonly listeners = new Set<(event: MessageLogEvent) => void>();

	private readonly logger: Logger;
	private readonly filePath: string;

	constructor(options: MessageLogOptions) {
		this.logger = options.logger;
		this.filePath = join(options.dataDir, 'message-log.ndjson');
	}

	/** 当前缓冲条数。 */
	get size(): number {
		return this.entries.length;
	}

	/** WebUI 热应用：同步开关 / 上限 / 落盘开关（上限变小立即裁剪）。 */
	reconfigure(config: { messageLog: boolean; messageLogMax: number; messageLogToFile: boolean }): void {
		this.enabled = config.messageLog;
		this.fileEnabled = config.messageLogToFile;
		if (config.messageLogMax !== this.maxEntries) {
			this.maxEntries = config.messageLogMax;
			if (this.entries.length > this.maxEntries) {
				this.entries = this.entries.slice(this.entries.length - this.maxEntries);
			}
		}
	}

	/**
	 * 订阅日志事件（WebUI 实时视图用）。
	 * 监听器在 record()/clear() 里同步调用，异常只忽略——日志订阅者绝不能
	 * 影响消息主链路；调用方负责在断开连接时调用返回的退订函数。
	 */
	subscribe(listener: (event: MessageLogEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 记录一条；内容超长截断，任何错误只降级为 warn。 */
	record(entry: Omit<MessageLogEntry, 'seq' | 'ts'>): void {
		if (!this.enabled) return;
		const full: MessageLogEntry = {
			...entry,
			text: entry.text.length > MAX_TEXT_CHARS ? `${entry.text.slice(0, MAX_TEXT_CHARS)}…` : entry.text,
			seq: ++this.seq,
			ts: Date.now(),
		};
		this.entries.push(full);
		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}
		this.emit({ kind: 'append', entry: full });
		if (this.fileEnabled) void this.appendToFile(full);
	}

	/**
	 * 取最近的条目（旧→新排序）。
	 * @param opts.limit 最多返回条数（默认全部）
	 * @param opts.chatId 只取该会话（chatId 精确匹配）
	 * @param opts.dir 只取该方向
	 */
	recent(opts: { limit?: number; chatId?: string; dir?: LogDirection } = {}): MessageLogEntry[] {
		let list = this.entries;
		if (opts.chatId !== undefined) list = list.filter((entry) => entry.chatId === opts.chatId);
		if (opts.dir !== undefined) list = list.filter((entry) => entry.dir === opts.dir);
		return opts.limit !== undefined && list.length > opts.limit ? list.slice(list.length - opts.limit) : [...list];
	}

	/** 清空内存缓冲（不影响已落盘文件）；实时视图同步清屏。 */
	clear(): void {
		this.entries = [];
		this.emit({ kind: 'clear' });
	}

	/** 同步派发一条事件；监听器抛错只忽略（不记日志，避免日志风暴）。 */
	private emit(event: MessageLogEvent): void {
		if (this.listeners.size === 0) return;
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// 忽略：订阅者是 WebUI 流，主链路优先。
			}
		}
	}

	/** NDJSON 落盘：fire-and-forget，出错只 warn 一次级不阻塞。 */
	private async appendToFile(entry: MessageLogEntry): Promise<void> {
		try {
			this.fileWrittenSinceCheck += 1;
			if (this.fileWrittenSinceCheck >= ROTATE_CHECK_INTERVAL) {
				this.fileWrittenSinceCheck = 0;
				try {
					const info = await stat(this.filePath);
					if (info.size > FILE_ROTATE_BYTES) await rename(this.filePath, `${this.filePath}.old`);
				} catch {
					// 文件还不存在：无需轮转。
				}
			}
			await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 消息日志落盘失败: ${error instanceof Error ? error.message : String(error)}`);
			this.fileEnabled = false;
		}
	}
}
