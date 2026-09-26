/**
 * 入站分发：归一化 → 防环/去重 → 信息过滤 → 访问控制 → 唤醒判定 →
 * 命令分发 / 限速 → 会话桥入队；顺带处理戳一戳与好友/群请求。
 */
import type { DshQQConfig } from '../config.ts';
import type { OneBotApi } from '../onebot/api.ts';
import { messageImages, normalizeEvent, type InboundEvent, type InboundMessage, type RawEvent } from '../onebot/events.ts';
import { AccessControl, MsgDeduper, RateLimiter, type AdminStore } from './access.ts';
import { evaluateWake, isEffectivelyEmpty, matchMessageFilter } from './wake.ts';
import { COMMANDS, parseCommand, type CommandContext } from '../commands/index.ts';
import { resolveImages } from '../media/inbound.ts';
import { resolveQuoted } from '../bridge/prompt.ts';
import type { ChatBridgeManager } from '../bridge/chat.ts';
import { chatKeyFor } from '../bridge/chat.ts';
import type { ChatHistoryService } from '../onebot/history.ts';
import type { MemoryLike } from '../memory/index.ts';
import type { PersonaStore } from '../persona/store.ts';
import type { RosterService } from '../onebot/roster.ts';
import type { DshServices } from '../dsh.ts';
import type { Logger } from '../types.ts';
import type { PokeNotice } from '../onebot/events.ts';
import type { MessageLogService } from '../logs/store.ts';
import type { ScheduledTask, TaskStore } from '../tasks/store.ts';

export interface DispatcherDeps {
	config: DshQQConfig;
	logger: Logger;
	api: OneBotApi;
	manager: ChatBridgeManager;
	admins: AdminStore;
	access: AccessControl;
	store: PersonaStore;
	roster: RosterService;
	/** 聊天记录缓冲（qq_read_history 的数据源；记录所有通过访问控制的消息）。 */
	history: ChatHistoryService;
	/**
	 * 长期记忆（默认关闭，未启用时给 ready=false 的实现）。
	 * 采集点与聊天记录缓冲并列：**都在信息过滤与访问控制之后**，所以
	 * "命中过滤前缀的消息连记忆都不进"，作用域也只有通过准入的会话。
	 */
	memory?: MemoryLike;
	services: DshServices;
	logs: MessageLogService;
	/** 定时任务库（/tasks 命令用）。 */
	tasks: TaskStore;
	/** 立即触发一个定时任务（/tasks run 用；与调度器共用会话桥管线）。 */
	runTask(task: ScheduledTask): void;
	getSelfId: () => string;
	setSelfId: (id: string) => void;
}

export class Dispatcher {
	private readonly deduper = new MsgDeduper();
	private readonly limiter: RateLimiter;
	private readonly rateNoticeAt = new Map<string, number>();

	constructor(private readonly deps: DispatcherDeps) {
		this.limiter = new RateLimiter(deps.config.rateLimit.windowMs, deps.config.rateLimit.max);
	}

	/** WebUI 配置热应用：限速参数变化时同步到构造时快照的 limiter。 */
	reconfigureRateLimit(config: DshQQConfig): void {
		this.limiter.configure(config.rateLimit.windowMs, config.rateLimit.max);
	}

	handle(raw: RawEvent): void {
		const event = normalizeEvent(raw);
		if (event === null) return;
		if (event.selfId !== '') this.deps.setSelfId(event.selfId);
		this.recordInbound(event);
		switch (event.kind) {
			case 'message':
				void this.handleMessage(event).catch((error: unknown) => {
					this.deps.logger.error(`dsh-qq-bot: 消息处理异常: ${error instanceof Error ? error.message : String(error)}`);
				});
				break;
			case 'poke':
				void this.handlePoke(event);
				break;
			case 'friendRequest':
				void this.handleFriendRequest(event);
				break;
			case 'groupRequest':
				void this.handleGroupRequest(event);
				break;
		}
	}

	private bridgeFor(msg: InboundMessage) {
		return this.deps.manager.bridgeFor(msg.chatType, msg.chatId, msg.senderId, msg.senderName);
	}

	/** 消息日志：归一化后的入站事件（含机器人自己的消息，防环判定在后续步骤）。 */
	private recordInbound(event: InboundEvent): void {
		if (event.kind === 'message') {
			this.deps.logs.record({
				dir: 'in',
				scope: 'onebot',
				event: 'message',
				chatType: event.chatType,
				chatId: event.chatId,
				senderId: event.senderId,
				senderName: event.senderName,
				text: event.text === '' ? (event.hasImage ? '[图片]' : '（无文本）') : event.text,
				detail: `message_id=${event.messageId ?? '?'}${event.mentionMe ? ' @机器人' : ''}`,
			});
			return;
		}
		if (event.kind === 'poke') {
			this.deps.logs.record({
				dir: 'in',
				scope: 'onebot',
				event: 'poke',
				chatType: event.chatType,
				chatId: event.groupId ?? event.senderId,
				senderId: event.senderId,
				text: `戳一戳 ${event.senderId} → ${event.targetId}`,
			});
			return;
		}
		if (event.kind === 'friendRequest') {
			this.deps.logs.record({
				dir: 'in',
				scope: 'onebot',
				event: 'friendRequest',
				chatType: 'private',
				chatId: event.userId,
				senderId: event.userId,
				senderName: event.nickname,
				text: `好友请求：${event.comment || '（无附言）'}`,
			});
			return;
		}
		this.deps.logs.record({
			dir: 'in',
			scope: 'onebot',
			event: 'groupRequest',
			chatType: 'group',
			chatId: event.groupId,
			senderId: event.userId,
			senderName: event.nickname,
			text: `群请求（${event.subType}）：${event.comment || '（无附言）'}`,
		});
	}

	/** 消息日志：管线丢弃原因（为什么这条消息没有触发回复）。 */
	private recordDrop(msg: InboundMessage, reason: string, detail?: string): void {
		this.deps.logs.record({
			dir: 'sys',
			scope: 'pipeline',
			event: 'drop',
			chatType: msg.chatType,
			chatId: msg.chatId,
			senderId: msg.senderId,
			senderName: msg.senderName,
			text: reason,
			detail,
		});
	}

	/**
	 * 记一条长期记忆事件（未启用 / 未准入 / 出错都静默）。
	 *
	 * 为什么单独包一层：桥的创建可能失败（目录权限等），而记忆绝不能反向影响
	 * 消息主链路 —— 这里全部吞掉，只在 debug 日志留痕。
	 */
	private recordMemory(msg: InboundMessage): void {
		const memory = this.deps.memory;
		if (memory === undefined || !memory.ready) return;
		try {
			const bridge = this.bridgeFor(msg);
			memory.record({
				chatKey: bridge.key,
				generation: bridge.sessionIdString,
				ts: (typeof msg.time === 'number' && msg.time > 0 ? msg.time : Math.floor(Date.now() / 1000)) * 1000,
				senderId: msg.senderId,
				senderName: msg.senderName !== '' ? msg.senderName : msg.senderId,
				self: false,
				kind: 'chat',
				text: msg.plainText !== '' ? msg.plainText : msg.hasImage ? '[图片]' : '（无内容）',
				...(msg.messageId !== undefined ? { msgId: String(msg.messageId) } : {}),
			});
		} catch (error) {
			this.deps.logger.warn(
				`dsh-qq-bot: 记忆采集失败（不影响消息处理）: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async handleMessage(msg: InboundMessage): Promise<void> {
		const { config, logger } = this.deps;
		// 防环：忽略机器人自己（及其它设备同步）的消息。
		if (msg.senderId === this.deps.getSelfId()) {
			// 自己发的话仍是"聊天记录"的一部分（模型读取时标记为【你】）。
			this.deps.history.recordMessage(msg);
			this.recordDrop(msg, '机器人自己的消息（防环忽略）');
			return;
		}
		if (!this.deduper.checkAndMark(msg.messageId !== undefined ? String(msg.messageId) : undefined)) {
			if (config.debug) logger.info(`dsh-qq-bot: 重复消息丢弃 ${msg.messageId}`);
			this.recordDrop(msg, '重复消息，已去重丢弃');
			return;
		}
		// 信息过滤（messageFilter）：命中前缀的消息整条丢弃，先于访问控制与唤醒
		// 判定，所以 / 指令、@机器人、私聊与群聊都不触发回复——这是"这类消息我
		// 完全不想被机器人看到"的语义，静默丢弃而不回"已忽略"。
		const filtered = matchMessageFilter(msg.plainText, config.messageFilter);
		if (filtered !== undefined) {
			if (config.debug) logger.info(`dsh-qq-bot: 消息命中过滤前缀「${filtered}」丢弃 ${msg.chatType} ${msg.chatId}`);
			this.recordDrop(msg, `命中信息过滤前缀「${filtered}」，忽略`);
			return;
		}
		// 访问控制（黑名单 > 管理员 > 模式）。
		const allowed =
			msg.chatType === 'private'
				? this.deps.access.checkPrivate(msg.chatId)
				: this.deps.access.checkGroup(msg.chatId, msg.senderId);
		if (!allowed) {
			// 群聊：拒绝是常态而不是事件——群没进白名单时这个群的每条消息都会
			// 被拒，@机器人 与否都不改变"本来就不该回"的结论，逐条记「访问控制
			// 拒绝」只会把消息日志刷满。所以群聊一律静默丢弃、不记 drop；
			// **收到的消息本身仍然照常记录**（handle() 里的 recordInbound 在访问
			// 控制之前，日志视图里那条 in 记录不会少），需要排查"为什么不回复"
			// 时开 debug（下面那行 logger.info 带群号与发送者）。
			// 私聊一律记一条：每条私聊都是明确对话，陌生人私聊值得留痕。
			const silent = msg.chatType === 'group';
			if (config.debug) logger.info(`dsh-qq-bot: 访问拒绝 ${msg.chatType} ${msg.chatId} from ${msg.senderId}`);
			if (!silent) this.recordDrop(msg, '访问控制拒绝');
			return;
		}

		// 群消息统一记入成员活跃度（不只是唤醒消息——都在"最近发言"里），
		// 同时后台保证群成员列表新鲜；内部绝不阻塞消息链路。
		if (msg.chatType === 'group') this.deps.roster.touchGroup(msg.chatId, msg.senderId);
		// 聊天记录缓冲：记下所有通过访问控制的消息（含没有唤醒机器人的普通
		// 发言），agent 被唤醒后可用 qq_read_history 回看"刚才在聊什么"。
		// 位置在信息过滤之后是有意的：命中过滤前缀的消息连记录都不留。
		this.deps.history.recordMessage(msg);
		// 长期记忆的会话档案：同一位置、同一语义（过滤之后、准入之后）。
		// 世代 id 取桥上记录的当前 sessionId（rotate/reset 后会变，交接靠它判断）。
		this.recordMemory(msg);

		const wake = evaluateWake(msg, config);

		// 命令：显式 '/' 前缀，先于限速与 agent。
		const command = parseCommand(msg.plainText);
		if (command !== null) {
			const def = COMMANDS[command.name];
			if (def !== undefined) {
				if (def.adminOnly === true && !this.deps.admins.isAdmin(msg.senderId)) {
					await this.bridgeFor(msg).sendText('❌ 该命令仅管理员可用');
					return;
				}
				const bridge = this.bridgeFor(msg);
				// 命令回执走 sendText（无装饰），这里记上下文只为命令内部主动回复（如 /status 的分块）。
				bridge.setReplyContext(msg.messageId, msg.senderId, 'other');
				const ctx: CommandContext = {
					msg,
					arg: command.arg,
					bridge,
					manager: this.deps.manager,
					api: this.deps.api,
					config,
					admins: this.deps.admins,
					store: this.deps.store,
					services: this.deps.services,
					logs: this.deps.logs,
					tasks: this.deps.tasks,
					runTask: (task) => this.deps.runTask(task),
					memory: this.deps.memory,
					reply: (text) => bridge.reply(text),
				};
				await def.run(ctx);
				return;
			}
			// 未知命令：当作普通消息（若已唤醒则进 agent，否则落回唤醒判定）。
		}

		// agent 提问的回答：正在等回答时，这条消息直接投给那一轮（见 bridge/ask.ts
		// 的 acceptAsAnswer——私聊任意文本、群聊限「本来会唤醒的 / 引用提问消息的 /
		// 提问触发者本人」），不再走唤醒判定：群里回一个"1"或"解释"不该要求 @。
		// 位置在命令之后：/reset、/status 这类控制指令优先于回答。
		// 用 getByChatKey 而不是 bridgeFor：没有待回答的会话不该因为一条普通消息
		// 就顺手建立起会话桥（目录、身份表都会跟着落地）。
		const answerKey = chatKeyFor(msg.chatType, msg.chatId, msg.senderId, config.groupSession);
		const pendingBridge = this.deps.manager.getByChatKey(answerKey);
		if (pendingBridge !== undefined && pendingBridge.acceptAnswer(msg.plainText, msg, wake.woke)) {
			if (config.debug) logger.info(`dsh-qq-bot: ${pendingBridge.label} 消息已作为提问的回答投递`);
			return;
		}

		if (!wake.woke) return;

		// 限速（只限制进 agent 的消息）。
		const rateKey = msg.chatType === 'group' ? `g-${msg.chatId}` : `u-${msg.chatId}`;
		if (!this.limiter.consume(rateKey)) {
			const now = Date.now();
			const last = this.rateNoticeAt.get(rateKey) ?? 0;
			if (now - last > config.rateLimit.windowMs) {
				this.rateNoticeAt.set(rateKey, now);
				await this.bridgeFor(msg).sendText('（消息太频繁，休息一下再聊）');
			}
			this.recordDrop(msg, '触发限速，丢弃');
			return;
		}

		// 纯 @ 无内容。
		if (isEffectivelyEmpty(wake, msg.hasImage)) {
			if (config.debug) logger.info(`dsh-qq-bot: 空 @ 消息 ${msg.chatType} ${msg.chatId}`);
			this.recordDrop(msg, '空 @ / 无有效内容');
			return;
		}

		const bridge = this.bridgeFor(msg);
		// 群聊里被 @ 触发时引用那条 @ 消息（QQ 的引用回复，replyQuoteOnMention）。
		bridge.setReplyContext(msg.messageId, msg.senderId, wake.via === 'mention' ? 'mention' : 'other');
		const msgIdForMedia = String(msg.messageId ?? `${Date.now()}`);
		const groupIdForRoster = msg.chatType === 'group' ? msg.chatId : undefined;
		const accepted = bridge.enqueue(async () => {
			const media = await resolveImages(messageImages(msg), {
				api: this.deps.api,
				config,
				mediaDir: bridge.mediaDir,
				logger,
				msgId: msgIdForMedia,
			});
			// 引用还原 + @提及重写（网络调用放在会话队列内，保持顺序）。
			const quoted = await resolveQuoted({
				api: this.deps.api,
				replyMessageId: msg.replyMessageId,
				maxChars: config.quoteMaxChars,
				logger,
			});
			if (quoted !== undefined && groupIdForRoster !== undefined) {
				quoted.text = await this.deps.roster.renderMentions(quoted.text, groupIdForRoster);
			}
			const text = await this.deps.roster.renderMentions(wake.text, groupIdForRoster);
			await bridge.handleMessage(text, msg, media, quoted);
		});
		if (!accepted) {
			logger.warn(`dsh-qq-bot: ${bridge.label} 队列已满，丢弃消息`);
			this.recordDrop(msg, '会话队列已满', `queue> ${config.maxQueue}`);
			await bridge.sendText('（消息太多忙不过来，稍后再发）');
		}
	}

	private async handlePoke(event: PokeNotice): Promise<void> {
		const text = this.deps.config.pokeReply;
		if (text === '' || event.targetId !== this.deps.getSelfId()) return;
		const target =
			event.chatType === 'group' && event.groupId !== undefined
				? { chatType: 'group' as const, groupId: event.groupId }
				: { chatType: 'private' as const, userId: event.senderId };
		await this.deps.api.sendText(target, text, this.deps.config.replyMaxChars);
	}

	private async handleFriendRequest(event: { flag: string; userId: string; nickname: string; comment: string }): Promise<void> {
		this.deps.logger.info(`dsh-qq-bot: 好友请求 ${event.nickname}(${event.userId})：${event.comment || '（无附言）'}`);
		if (this.deps.config.autoApproveRequests) {
			const ok = await this.deps.api.setFriendAddRequest(event.flag, true);
			if (ok) this.deps.logger.info(`dsh-qq-bot: 已自动同意好友请求 ${event.userId}`);
		}
	}

	private async handleGroupRequest(event: { flag: string; groupId: string; userId: string; subType: string; comment: string }): Promise<void> {
		this.deps.logger.info(`dsh-qq-bot: 群请求 ${event.groupId} ${event.subType} from ${event.userId}：${event.comment || '（无附言）'}`);
		if (this.deps.config.autoApproveRequests) {
			const ok = await this.deps.api.setGroupAddRequest(event.flag, event.subType, true);
			if (ok) this.deps.logger.info(`dsh-qq-bot: 已自动同意群请求 ${event.groupId} from ${event.userId}`);
		}
	}
}
