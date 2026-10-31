/**
 * 群成员身份的内部映射（纯宿主逻辑，不进 client bundle）。
 *
 * 模型永远看不到 QQ 号：蒸馏输入/输出与画像渲染都只使用 `member_ref`
 * （`m_` + 10 位 hash）和昵称；ref 与 QQ 号的映射只落在 `memory_members` 表里。
 *
 * ref 的稳定性很重要：同一个人在同一个群里换会话、换 perUser 模式、重启进程，
 * 都必须得到同一个 ref，否则蒸馏会把同一个人拆成多个画像。
 */

import { createHash } from 'node:crypto';
import { sanitizeMemoryText } from './guard.ts';

/** 从 chatKey 推出“群级”键：perUser 群会话与共享群会话共用同一组成员画像。 */
export function groupKeyOf(chatKey: string): string {
	const perUser = /^g-(\d+)-u-\d+$/.exec(chatKey);
	if (perUser !== null) return `g-${perUser[1]}`;
	return chatKey;
}

/** 稳定的匿名成员 ref：同一群 + 同一 QQ 号永远得到同一值，且不可反推号码。 */
export function memberRefFor(chatKey: string, memberId: string): string {
	const digest = createHash('sha256').update(`${groupKeyOf(chatKey)}\u0000${memberId}`).digest('hex');
	return `m_${digest.slice(0, 10)}`;
}

/** 模型可见的成员名：只保留昵称；空昵称回退为“群友”，绝不回退成号码。 */
export function memberDisplayName(name: string | undefined, fallback = '群友'): string {
	const text = sanitizeMemoryText(name ?? '').trim();
	return text === '' ? fallback : text;
}

/** 是否为群会话（共享群 / perUser 群）。 */
export function isGroupChatKey(chatKey: string): boolean {
	return /^g-\d+(?:-u-\d+)?$/.test(chatKey);
}
