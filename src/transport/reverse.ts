/**
 * 反向 WS transport：插件起 WebSocket 服务端，napcat 以
 * 「网络监听 → WebSocket 客户端（反向 WS）」连入（AstrBot 同款拓扑）。
 *
 * 同一时刻只保留一条活跃连接；新连接进入时旧连接被替换。
 * 鉴权支持 Authorization: Bearer 与 ?access_token= 两种方式。
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { EchoChannel, type OneBotTransport, type TransportOptions } from './base.ts';

export class ReverseTransport implements OneBotTransport {
	readonly kind = 'reverse' as const;

	private readonly channel: EchoChannel;
	private server: WebSocketServer | null = null;
	private socket: WebSocket | null = null;
	private closed = true;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly port: number,
		private readonly path: string,
		private readonly options: TransportOptions,
	) {
		this.channel = new EchoChannel(options.logger, options.onEvent);
	}

	get connected(): boolean {
		return this.channel.connected;
	}

	start(): void {
		if (!this.closed) return;
		this.closed = false;
		const server = new WebSocketServer({ port: this.port }, () => {
			this.options.logger.info(`dsh-qq-bot: reverse WS listening on 0.0.0.0:${this.port}${this.path || ' (any path)'}`);
		});
		this.server = server;
		server.on('error', (error) => {
			this.options.logger.error(`dsh-qq-bot: reverse WS server error: ${error.message}`);
		});
		server.on('connection', (socket, request) => this.handleConnection(socket, request));
		this.startHeartbeat();
	}

	stop(): void {
		if (this.closed && this.server === null) return;
		this.closed = true;
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		const socket = this.socket;
		this.socket = null;
		this.channel.detach(socket as never);
		this.channel.rejectPending(new Error('onebot transport stopped'));
		if (socket !== null) {
			try {
				socket.close(1001);
			} catch {
				// ignore
			}
		}
		const server = this.server;
		this.server = null;
		if (server !== null) {
			try {
				server.close();
			} catch {
				// ignore
			}
		}
		this.options.onStatus?.({ connected: false });
	}

	call(action: string, params?: Record<string, unknown>): Promise<unknown> {
		return this.channel.call(action, params);
	}

	private authorized(request: IncomingMessage, url: URL): boolean {
		if (this.options.accessToken === '') return true;
		const header = request.headers.authorization ?? '';
		if (header === `Bearer ${this.options.accessToken}` || header === this.options.accessToken) return true;
		return url.searchParams.get('access_token') === this.options.accessToken;
	}

	private handleConnection(socket: WebSocket, request: IncomingMessage): void {
		let url: URL;
		try {
			url = new URL(request.url ?? '/', 'http://localhost');
		} catch {
			url = new URL('/', 'http://localhost');
		}
		if (this.path !== '' && url.pathname !== this.path) {
			this.options.logger.warn(`dsh-qq-bot: rejecting reverse WS connection on unexpected path ${url.pathname}`);
			socket.close(1008, 'unexpected path');
			return;
		}
		if (!this.authorized(request, url)) {
			this.options.logger.warn('dsh-qq-bot: rejecting reverse WS connection with invalid access token');
			socket.close(4001, 'invalid access token');
			return;
		}
		// 新连接替换旧连接（napcat 重连场景避免双活）。
		const previous = this.socket;
		if (previous !== null && previous !== socket) {
			try {
				previous.close(1000, 'replaced by new connection');
			} catch {
				// ignore
			}
		}
		this.socket = socket;
		this.channel.attach(socket);
		this.options.logger.info(`dsh-qq-bot: napcat connected via reverse WS from ${request.socket.remoteAddress ?? 'unknown'}`);
		this.options.onStatus?.({ connected: true });

		socket.on('message', (data) => {
			this.channel.handleFrame(data);
		});
		socket.on('error', (error) => {
			this.options.logger.warn(`dsh-qq-bot: reverse socket error: ${error.message}`);
		});
		socket.on('close', () => {
			this.channel.detach(socket);
			if (this.socket === socket) {
				this.socket = null;
				this.channel.rejectPending(new Error('onebot connection closed'));
				this.options.onStatus?.({ connected: false });
			}
		});
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = this.channel.startHeartbeat(() => (this.socket !== null ? this.channel : null));
	}
}
