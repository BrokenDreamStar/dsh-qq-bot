/**
 * 正向 WS transport：插件作为 WebSocket 客户端连 napcat 的
 * 「网络监听 → WebSocket 服务器（正向 WS）」。
 *
 * 断线自动重连（指数退避，60s 封顶）+ 30s get_version_info 心跳探活。
 */
import WebSocket from 'ws';
import { EchoChannel, MAX_RECONNECT_MS, type OneBotTransport, type TransportOptions } from './base.ts';

export class ForwardTransport implements OneBotTransport {
	readonly kind = 'forward' as const;

	private readonly channel: EchoChannel;
	private socket: WebSocket | null = null;
	private closed = true;
	private attempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly url: string,
		private readonly options: TransportOptions,
	) {
		this.channel = new EchoChannel(options.logger, options.onEvent);
	}

	get connected(): boolean {
		return this.channel.connected;
	}

	start(): void {
		this.closed = false;
		this.attempt = 0;
		this.connect();
	}

	stop(): void {
		this.closed = true;
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.channel.rejectPending(new Error('onebot transport stopped'));
		const socket = this.socket;
		this.socket = null;
		if (socket !== null) {
			this.channel.detach(socket);
			socket.removeAllListeners();
			try {
				socket.close();
			} catch {
				// ignore
			}
			try {
				socket.terminate();
			} catch {
				// ignore
			}
		}
		this.options.onStatus?.({ connected: false });
	}

	call(action: string, params?: Record<string, unknown>): Promise<unknown> {
		return this.channel.call(action, params);
	}

	private connect(): void {
		if (this.closed) return;
		this.attempt += 1;
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.url, {
				headers: this.options.accessToken === '' ? undefined : { Authorization: `Bearer ${this.options.accessToken}` },
			});
		} catch (error) {
			this.options.logger.warn(`dsh-qq-bot: invalid forward WS url (${error instanceof Error ? error.message : String(error)})`);
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		this.channel.attach(socket);

		socket.on('open', () => {
			this.attempt = 0;
			this.options.logger.info(`dsh-qq-bot: connected to OneBot at ${this.url}`);
			this.options.onStatus?.({ connected: true });
			this.startHeartbeat();
		});
		socket.on('message', (data) => {
			this.channel.handleFrame(data);
		});
		socket.on('error', (error) => {
			this.options.logger.warn(`dsh-qq-bot: forward socket error: ${error.message}`);
			this.options.onStatus?.({ connected: false, error });
		});
		socket.on('close', () => {
			this.stopHeartbeat();
			this.channel.detach(socket);
			if (this.socket === socket) this.socket = null;
			this.channel.rejectPending(new Error('onebot connection closed'));
			this.options.onStatus?.({ connected: false });
			this.scheduleReconnect();
		});
	}

	private scheduleReconnect(): void {
		if (this.closed) return;
		const delay = Math.min(MAX_RECONNECT_MS, this.options.reconnectDelayMs * 2 ** Math.min(this.attempt, 6));
		this.options.logger.info(`dsh-qq-bot: reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempt})`);
		this.retryTimer = setTimeout(() => this.connect(), delay);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = this.channel.startHeartbeat(() => (this.socket !== null ? this.channel : null));
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}
}
