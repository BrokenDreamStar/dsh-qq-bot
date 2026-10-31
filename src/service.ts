/**
 * dsh-qq-bot 的插件间组合面。
 *
 * 只公开稳定、窄小的 QQ 适配能力，不暴露 ChatBridgeManager、配置对象或
 * OneBot 原始 action。消费者通过 `inject = ['dshQQBot']` 使用本服务，
 * 不需要 import 本插件的实现；独立插件只需要这里的公共类型。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { AccessControl } from './pipeline/access.ts';
import type { OneBotApi } from './onebot/api.ts';
import type { DshQQConfig } from './config.ts';

declare module '@deepseek-ai/cordis' {
	interface Context {
		dshQQBot: DshQQBotService;
	}
}

/** 跨插件 API 使用的目标形状（私聊用 userId，群聊用 groupId）。 */
export type QQServiceTarget =
	| { chatType: 'private'; userId: string }
	| { chatType: 'group'; groupId: string };

/** 交给扩展插件的入站消息快照；原始 OneBot 事件仍由本插件所有。 */
export interface QQServiceMessage {
	chatType: 'private' | 'group';
	chatId: string;
	senderId: string;
	senderName: string;
	messageId?: number;
	/** 去掉开头的 @机器人 后的纯文本。 */
	text: string;
	mentionMe: boolean;
	/** 消息引用的原消息 id（如有）。 */
	replyMessageId?: string;
	time: number;
}

/** 主动文本发送的结果；null messageId 表示对接端没有确认发送成功。 */
export interface QQSendTextResult {
	messageId: number | null;
}

export interface DshQQBotServiceOptions {
	api: OneBotApi;
	access: AccessControl;
	config: DshQQConfig;
}

/** 消息处理器的执行结果：true = 已消费，不再进入 agent；false = 放行。 */
export type QQMessageHandler = (message: QQServiceMessage) => boolean | Promise<boolean>;

export class DshQQBotService extends Service {
	private readonly handlers = new Set<QQMessageHandler>();

	constructor(ctx: Context, private readonly options: DshQQBotServiceOptions) {
		super(ctx, 'dshQQBot');
	}

	/** QQ 连接是否在线。 */
	get connected(): boolean {
		return this.options.api.connected;
	}

	/**
	 * 向一个 QQ 目标发送文本，按本插件的单条消息上限自动切块。
	 *
	 * 主动消息与入站对话遵循同一套渠道准入配置：目标群/用户被拉黑、
	 * 对应渠道 disabled，或 allowlist 模式下目标不在白名单，都会被拒绝。
	 * 调用方失败后可重试；不会用 null messageId 冒充成功。
	 */
	async sendText(target: QQServiceTarget, text: string): Promise<QQSendTextResult> {
		if (typeof text !== 'string' || text.trim() === '') {
			throw new Error('dsh-qq-bot: 主动消息正文不能为空');
		}
		if (!this.connected) {
			throw new Error('dsh-qq-bot: QQ 当前未连接，主动消息未发送');
		}
		const rawId = target.chatType === 'private' ? target.userId : target.groupId;
		const id = String(rawId).trim();
		if (!/^\d+$/.test(id)) {
			throw new Error(`dsh-qq-bot: 无效的 QQ ${target.chatType === 'group' ? '群号' : '号'}：${String(rawId)}`);
		}
		const normalized: QQServiceTarget =
			target.chatType === 'private' ? { chatType: 'private', userId: id } : { chatType: 'group', groupId: id };
		const allowed =
			normalized.chatType === 'private'
				? this.options.access.checkPrivate(normalized.userId)
				: this.options.access.checkGroup(normalized.groupId, '');
		if (!allowed) {
			throw new Error(`dsh-qq-bot: 目标 ${normalized.chatType} ${id} 未通过 QQ 插件的访问控制，拒绝主动发送`);
		}
		const messageId = await this.options.api.sendText(normalized, text, this.options.config.replyMaxChars);
		return { messageId };
	}

	/**
	 * 注册一个轻量消息处理器，返回注销函数。
	 *
	 * 处理器位于防环/去重/过滤/访问控制之后，唤醒、命令、提问回答与 agent 之前。
	 * 因此它只能看到本插件允许处理的会话；返回 true 可消费该消息，返回
	 * false 则交还主管线。主要用于 #命令 等不需要 agent 的扩展功能。
	 */
	onMessage(handler: QQMessageHandler): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	/** @internal 仅 Dispatcher 调用；不是插件间公共能力。 */
	async dispatchMessage(message: QQServiceMessage): Promise<boolean> {
		for (const handler of [...this.handlers]) {
			if (await handler(message)) return true;
		}
		return false;
	}
}
