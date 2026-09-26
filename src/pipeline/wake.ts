/**
 * 唤醒判定（对齐 AstrBot WakingCheck 语义的子集）：
 *  - 群聊：@机器人 / 唤醒前缀 / '/' 指令触发；groupMentionOnly=false 时任意消息触发
 *  - 私聊：默认任意消息触发；privateNeedsWake=true 时需前缀或指令
 *  - 输出剥离 @机器人 段与唤醒前缀后的干净文本
 * 另含信息过滤（messageFilter）：命中前缀的消息在唤醒判定之前就被丢弃。
 */
import type { DshQQConfig } from '../config.ts';
import type { InboundMessage } from '../onebot/events.ts';

export interface WakeOutcome {
	woke: boolean;
	/** 进入 agent / 命令分发的文本（已剥离唤醒标记）。 */
	text: string;
	/** 触发方式（日志用）。 */
	via: 'mention' | 'prefix' | 'command' | 'always' | 'private';
}

/**
 * 从消息开头剥离唤醒前缀。前缀必须出现在消息文本最前面
 * （plainText 与 text 共享开头的文本段，所以 text 的开头同样匹配）。
 */
function stripWakePrefix(text: string, prefixes: string[]): string {
	for (const prefix of prefixes) {
		if (prefix !== '' && text.startsWith(prefix)) {
			return text.slice(prefix.length).trimStart();
		}
	}
	return text;
}

export function evaluateWake(msg: InboundMessage, config: DshQQConfig): WakeOutcome {
	const isCommand = msg.plainText.startsWith('/');

	if (msg.chatType === 'private') {
		if (isCommand) return { woke: true, text: msg.text, via: 'command' };
		if (!config.privateNeedsWake) return { woke: true, text: msg.text, via: 'private' };
		const stripped = stripWakePrefix(msg.text, config.wakePrefixes);
		if (stripped !== msg.text) return { woke: true, text: stripped, via: 'prefix' };
		return { woke: false, text: '', via: 'private' };
	}

	// 群聊：指令优先（显式意图，不受 mentionOnly 限制，仍受访问控制约束）。
	if (isCommand) return { woke: true, text: msg.text, via: 'command' };
	const stripped = stripWakePrefix(msg.text, config.wakePrefixes);
	if (stripped !== msg.text) return { woke: true, text: stripped, via: 'prefix' };
	if (msg.mentionMe) return { woke: true, text: msg.text, via: 'mention' };
	if (!config.groupMentionOnly) return { woke: true, text: msg.text, via: 'always' };
	return { woke: false, text: '', via: 'mention' };
}

/** 纯 @ 无内容且无媒体时视为空消息（提示一次，不进 agent）。 */
export function isEffectivelyEmpty(wake: WakeOutcome, hasImage: boolean): boolean {
	return wake.text === '' && !hasImage;
}

/**
 * 信息过滤：返回命中的过滤前缀（未命中 undefined）。
 *
 * 语义是"以该前缀开头即整条丢弃"，与唤醒前缀无关：命中的消息**任何入口都
 * 不触发回复**——/ 指令、@机器人、私聊与群聊一律拦在唤醒判定之前。判定前
 * 先去掉开头的空白，所以"#说明"与" #说明"都算命中；前缀本身不做大小写折叠
 * （QQ 文本大小写敏感，折叠会让"A"顺带拦掉"abc"）。
 */
export function matchMessageFilter(text: string, prefixes: readonly string[]): string | undefined {
	const trimmed = text.trimStart();
	for (const prefix of prefixes) {
		if (prefix !== '' && trimmed.startsWith(prefix)) return prefix;
	}
	return undefined;
}
