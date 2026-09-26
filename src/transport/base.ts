/**
 * 传输层共用件：echo 匹配的 action 调用 + 入站帧路由。
 *
 * OneBot 11 的 WS 通信就是 JSON 帧：
 *  - 请求：{ action, params, echo }
 *  - 响应：{ status, retcode, data, echo }
 *  - 事件：{ post_type, ... }
 */
import type { RawData, WebSocket } from 'ws';
import type { Logger } from '../types.ts';
import type { RawEvent } from '../onebot/events.ts';

/** 单次 action 等待响应的最长时间（ms）。 */
export const ACTION_TIMEOUT_MS = 15_000;
/** 心跳间隔（ms）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳 action 超时（ms）；超时视为半死连接。 */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** 重连退避上限（ms）。 */
export const MAX_RECONNECT_MS = 60_000;

export interface TransportStatus {
	connected: boolean;
	error?: Error;
}

export interface TransportOptions {
	accessToken: string;
	reconnectDelayMs: number;
	logger: Logger;
	onEvent: (event: RawEvent) => void;
	onStatus?: (status: TransportStatus) => void;
}

export interface OneBotTransport {
	readonly kind: 'forward' | 'reverse';
	/** 当前是否有可用连接。 */
	readonly connected: boolean;
	start(): void;
	stop(): void;
	/** 发送一个 action 并等待 echo 响应，返回 data 字段。 */
	call(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface PendingEntry {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * 单条 WebSocket 上的 echo 通道。两条 transport 复用同一套帧路由逻辑。
 */
export class EchoChannel {
	private socket: WebSocket | null = null;
	private pending = new Map<string, PendingEntry>();
	private echoSeq = 0;

	constructor(
		private readonly logger: Logger,
		private readonly onEvent: (event: RawEvent) => void,
	) {}

	get connected(): boolean {
		return this.socket !== null && this.socket.readyState === 1; // WebSocket.OPEN
	}

	/** 绑定当前活跃 socket（旧 socket 的在途请求会被拒绝）。 */
	attach(socket: WebSocket): void {
		this.rejectPending(new Error('onebot connection replaced'));
		this.socket = socket;
	}

	/** 解绑 socket（stop / 断开时）。 */
	detach(socket: WebSocket): void {
		if (this.socket !== socket) return;
		this.socket = null;
	}

	/** 强制断开当前 socket（心跳超时判定的半死连接）。 */
	closeStale(): void {
		const socket = this.socket;
		if (socket === null) return;
		try {
			socket.terminate();
		} catch {
			// ignore
		}
	}

	rejectPending(error: Error): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	call(action: string, params: Record<string, unknown> = {}, timeoutMs = ACTION_TIMEOUT_MS): Promise<unknown> {
		const socket = this.socket;
		if (socket === null || socket.readyState !== 1) {
			return Promise.reject(new Error('onebot not connected'));
		}
		return new Promise<unknown>((resolve, reject) => {
			const echo = String(++this.echoSeq);
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				reject(new Error(`onebot action ${action} timed out`));
			}, timeoutMs);
			this.pending.set(echo, { resolve, reject, timer });
			try {
				socket.send(JSON.stringify({ action, params, echo }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(echo);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** 处理一帧入站 JSON；返回是否为协议帧（echo 响应或事件）。 */
	handleFrame(data: RawData): boolean {
		let payload: unknown;
		try {
			payload = JSON.parse(data.toString());
		} catch {
			return false;
		}
		if (payload === null || typeof payload !== 'object') return false;
		const frame = payload as Record<string, unknown>;
		if (frame.echo !== undefined) {
			const entry = this.pending.get(String(frame.echo));
			if (entry === undefined) return true;
			this.pending.delete(String(frame.echo));
			clearTimeout(entry.timer);
			const status = String(frame.status ?? '');
			if (status === 'ok' && frame.retcode === 0) entry.resolve(frame.data ?? {});
			else {
				entry.reject(new Error(`onebot action failed: ${status || 'failed'} (retcode ${String(frame.retcode ?? '?')}) ${String(frame.message ?? '')}`.trim()));
			}
			return true;
		}
		if (frame.post_type !== undefined) {
			this.onEvent(frame as RawEvent);
			return true;
		}
		return false;
	}

	/** 周期心跳：get_version_info 探活，失败即断开由外层重连。 */
	startHeartbeat(getChannel: () => EchoChannel | null): ReturnType<typeof setInterval> {
		return setInterval(() => {
			const channel = getChannel();
			if (channel === null || !channel.connected) return;
			channel.call('get_version_info', {}, HEARTBEAT_TIMEOUT_MS).catch(() => {
				this.logger.warn('dsh-qq-bot: heartbeat failed, closing stale socket');
				try {
					channel.closeStale();
				} catch {
					// ignore
				}
			});
		}, HEARTBEAT_INTERVAL_MS);
	}
}
