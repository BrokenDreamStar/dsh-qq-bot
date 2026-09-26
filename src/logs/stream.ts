/**
 * 消息日志实时流（SSE）：把 MessageLogService 的新条目即时推给 WebUI。
 *
 * 为什么不用轮询：配置页的日志视图原先每 4s 拉一次 `logs/recent`，最多滞后
 * 4s 且每次都是整表传输。这里改成一条长连接：
 *  - 建立连接时先发一份快照（{@link LogStreamFrame} 的 snapshot 帧）
 *  - 之后每条 record()/clear() 立即推送（append / clear 帧），零延迟
 *  - 客户端落后过多时丢弃新帧，队列排空后补发 resync 帧让客户端整表重拉
 *  - 心跳注释保活，浏览器 EventSource 断线后自动重连（重连即重新拿快照）
 *
 * 路由挂在 `connection.fetch` 的精确 Fetch 路由上（路径必须以 /api/ 开头，
 * 与共享 /api 通道同样受 Host/Origin 校验 + 浏览器 cookie 鉴权）；旧宿主没有
 * `connection.fetch` 时客户端退回轮询（见 client/components.tsx）。
 */
import type { MessageLogEntry, MessageLogService } from './store.ts';

/** 实时流路由路径（浏览器侧同名字符串见 client/components.tsx）。 */
export const LOG_STREAM_PATH = '/api/dsh-qq-bot/logs/stream';

/** 一帧 SSE 数据（data: 字段承载的 JSON）。 */
export type LogStreamFrame =
	/** 连接建立时的完整快照（旧→新）。 */
	| { kind: 'snapshot'; entries: MessageLogEntry[] }
	/** 新增一条记录。 */
	| { kind: 'append'; entry: MessageLogEntry }
	/** 宿主侧缓冲被清空。 */
	| { kind: 'clear' }
	/** 服务端曾丢帧，客户端应整表重拉（seq 可能不再连续）。 */
	| { kind: 'resync' };

/** 初始快照默认条数（与 logs/recent 的 WebUI 请求一致）。 */
const DEFAULT_LIMIT = 300;
/** 快照条数上限（与 logs/recent 端点保持一致）。 */
const MAX_LIMIT = 1000;
/** 心跳间隔：仅发注释行，防止中间层按空闲回收长连接。 */
const DEFAULT_HEARTBEAT_MS = 15000;
/** 未读队列超过该 chunk 数即视为客户端严重落后，开始丢帧。 */
const DROP_QUEUE_CHUNKS = 256;

export interface LogStreamOptions {
	/** 初始快照条数（覆盖 URL 里的 limit；测试用）。 */
	limit?: number;
	/** 心跳间隔毫秒（测试用）。 */
	heartbeatMs?: number;
	/** 丢帧阈值 chunk 数（测试用）。 */
	overflowChunks?: number;
}

/** 校验并归一化 limit：非数字/越界回落到默认值。 */
export function normalizeLogStreamLimit(value: unknown): number {
	const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/** 从请求 URL 的 ?limit= 读取快照条数（解析失败回落默认）。 */
function limitFromUrl(url: string): number {
	try {
		return normalizeLogStreamLimit(new URL(url).searchParams.get('limit'));
	} catch {
		return DEFAULT_LIMIT;
	}
}

/** 编码一帧 SSE（data: + 空行；注释心跳行见 createLogStreamResponse）。 */
export function encodeSseFrame(payload: LogStreamFrame): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 构造一条消息日志实时流的 HTTP 响应。
 *
 * @param logs 消息日志服务（订阅 + 快照来源）
 * @param request 已鉴权的 Fetch 请求；其 signal 在客户端断开时中止
 * @param options 快照条数 / 心跳间隔 / 丢帧阈值（默认见常量）
 */
export function createLogStreamResponse(
	logs: MessageLogService,
	request: Request,
	options: LogStreamOptions = {},
): Response {
	const limit = options.limit ?? limitFromUrl(request.url);
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const overflowChunks = options.overflowChunks ?? DROP_QUEUE_CHUNKS;
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let closed = false;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		unsubscribe?.();
		unsubscribe = undefined;
		if (heartbeat !== undefined) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		request.signal.removeEventListener('abort', cleanup);
		// 客户端断开（signal 中止）：主动收尾流，别让读者永远挂起。
		try {
			controller?.close();
		} catch {
			// 流已被消费者取消：无需再关。
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start(inner) {
			controller = inner;
			const write = (chunk: string): void => {
				if (closed) return;
				try {
					inner.enqueue(encoder.encode(chunk));
				} catch {
					// 流已被取消（客户端断开先于 signal）：释放订阅即可。
					cleanup();
				}
			};
			const frame = (payload: LogStreamFrame): void => {
				write(encodeSseFrame(payload));
			};
			// 客户端读得比生产慢很多时丢帧：等它追上后靠 resync 帧整表重拉。
			let droppedSinceResync = false;
			const behind = (): boolean => {
				const size: number | null = inner.desiredSize;
				return size !== null && size < -overflowChunks;
			};
			// 先订阅、再取快照：两者之间没有 await，事件不会穿插丢失。
			unsubscribe = logs.subscribe((event) => {
				if (behind()) {
					droppedSinceResync = true;
					return;
				}
				if (event.kind === 'clear') frame({ kind: 'clear' });
				else frame({ kind: 'append', entry: event.entry });
			});
			frame({ kind: 'snapshot', entries: logs.recent({ limit }) });
			// 显式告诉浏览器 2s 后重连（默认约 3s），断线恢复更贴合实时预期。
			write('retry: 2000\n\n');
			heartbeat = setInterval(() => {
				if (droppedSinceResync && !behind()) {
					droppedSinceResync = false;
					frame({ kind: 'resync' });
				}
				write(': ping\n\n');
			}, heartbeatMs);
			// 长连接定时器不应阻止进程退出（宿主长驻，纯防御）。
			(heartbeat as unknown as { unref?: () => void }).unref?.();
			request.signal.addEventListener('abort', cleanup);
			// 请求在注册前就已经中止（极早断开）：立刻收尾。
			if (request.signal.aborted) cleanup();
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		},
	});
}
