/**
 * 传输层日志包装：把发往 OneBot 对接端的 action 记入消息日志。
 *
 * 记录策略（避免刷屏）：
 *  - 消息类 action（send_msg / 合并转发 / 撤回 / 好友群请求处理）成功与失败都记；
 *  - 其余 action（get_image、get_msg、群成员列表等内部调用）只在失败时记
 *    （心跳 get_version_info 永不记，断线由 transport 自身日志负责）。
 *
 * withActionLogging 返回的包装实现完整 OneBotTransport，index.ts 在
 * createTransport / rebuildTransport 里包一层即可，api.attach 拿到的
 * 始终是包装后的实例。
 */
import type { OneBotTransport } from '../transport/base.ts';
import type { OBSegment } from '../onebot/segments.ts';
import type { MessageLogService } from './store.ts';

/** 心跳/版本探活：成功失败都不记。 */
const SILENT_ACTIONS = new Set(['get_version_info']);

/** 把消息段数组渲染成可读文本（媒体段用占位符）。 */
export function renderSegmentsText(segments: unknown): string {
	if (typeof segments === 'string') return segments;
	if (!Array.isArray(segments)) return '';
	return segments
		.map((raw: unknown) => {
			const segment = raw as Partial<OBSegment> | null;
			if (segment === null || typeof segment !== 'object') return '';
			const data = (segment.data ?? {}) as Record<string, unknown>;
			switch (segment.type) {
				case 'text':
					return typeof data.text === 'string' ? data.text : '';
				case 'image':
					return '[图片]';
				case 'at':
					return `@${String(data.qq ?? '')}`;
				case 'reply':
					return `[回复 ${String(data.id ?? '')}]`;
				case 'face':
					return '[表情]';
				case 'record':
					return '[语音]';
				case 'video':
					return '[视频]';
				case 'node':
					return renderSegmentsText(data.content);
				default:
					return `[${String(segment.type ?? '?')}]`;
			}
		})
		.filter((part) => part !== '')
		.join('');
}

/** 出站目标（写进日志的 chatType/chatId）：WebUI 与 /logs 会渲染成「群 123」/「好友 42」。 */
export interface ActionTarget {
	chatType: 'group' | 'private';
	chatId: string;
}

/**
 * 从 action 参数里提炼出站目标。
 *
 * 以前出站日志不带 chatId，WebUI 的会话列一律显示「未知会话」——排查"这条回复发到哪了"
 * 时只能看正文里的前缀。转发/请求处理类 action 由动作本身决定目标；`send_msg` 用
 * group_id / user_id 判定（delete_msg 这类没有目标的返回 undefined，保持"未知会话"）。
 */
export function actionTarget(action: string, params: Record<string, unknown> = {}): ActionTarget | undefined {
	const groupId = params.group_id !== undefined && params.group_id !== '' ? String(params.group_id) : '';
	const userId = params.user_id !== undefined && params.user_id !== '' ? String(params.user_id) : '';
	if (action === 'send_private_forward_msg' || action === 'set_friend_add_request') {
		return userId === '' ? undefined : { chatType: 'private', chatId: userId };
	}
	if (action === 'send_group_forward_msg' || action === 'set_group_add_request') {
		return groupId === '' ? undefined : { chatType: 'group', chatId: groupId };
	}
	if (groupId !== '') return { chatType: 'group', chatId: groupId };
	if (userId !== '') return { chatType: 'private', chatId: userId };
	return undefined;
}

/** 从 action 参数里提炼人话摘要；返回 undefined 表示该 action 无需成功记录。 */
export function summarizeAction(
	action: string,
	params: Record<string, unknown> = {},
): { text: string; detail?: string; target?: ActionTarget } | undefined {
	const target = actionTarget(action, params);
	const withTarget = <T extends { text: string; detail?: string }>(summary: T): T & { target?: ActionTarget } =>
		target === undefined ? summary : { ...summary, target };
	switch (action) {
		case 'send_msg':
			// 目标（群/好友）走 chatId 字段，不再重复写进正文：WebUI 与 /logs 都会渲染会话列。
			return withTarget({ text: renderSegmentsText(params.message) });
		case 'send_group_forward_msg':
		case 'send_private_forward_msg': {
			const nodes = Array.isArray(params.messages) ? params.messages : [];
			const text = nodes.map((node: unknown) => renderSegmentsText((node as { content?: unknown })?.content)).join('\n');
			return withTarget({ text: `[合并转发] ${text}` });
		}
		case 'delete_msg':
			return { text: `撤回消息 ${String(params.message_id ?? '')}` };
		case 'set_friend_add_request':
			return withTarget({ text: `${params.approve === true ? '同意' : '拒绝'}好友请求` });
		case 'set_group_add_request':
			return withTarget({
				text: `${params.approve === true ? '同意' : '拒绝'}群请求（${String(params.sub_type ?? '')}）申请人 ${String(params.user_id ?? '')}`,
			});
		default:
			return undefined;
	}
}

/** 给 transport 套一层 action 日志。 */
export function withActionLogging(inner: OneBotTransport, log: MessageLogService): OneBotTransport {
	return {
		kind: inner.kind,
		get connected() {
			return inner.connected;
		},
		start: () => inner.start(),
		stop: () => inner.stop(),
		async call(action, params = {}) {
			try {
				const data = await inner.call(action, params);
				const summary = summarizeAction(action, params);
				if (summary !== undefined) {
					const messageId = (data as { message_id?: number | string } | undefined)?.message_id;
					log.record({
						dir: 'out',
						scope: 'onebot',
						event: 'send',
						text: summary.text,
						...(summary.target !== undefined
							? { chatType: summary.target.chatType, chatId: summary.target.chatId }
							: {}),
						detail: messageId !== undefined ? `message_id=${String(messageId)}` : undefined,
					});
				}
				return data;
			} catch (error) {
				if (!SILENT_ACTIONS.has(action)) {
					const target = actionTarget(action, params);
					log.record({
						dir: 'out',
						scope: 'onebot',
						event: 'action-error',
						text: `action ${action} 失败`,
						...(target !== undefined ? { chatType: target.chatType, chatId: target.chatId } : {}),
						detail: error instanceof Error ? error.message : String(error),
					});
				}
				throw error;
			}
		},
	};
}
