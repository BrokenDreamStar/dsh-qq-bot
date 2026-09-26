/** 全局共享的轻量类型。 */

export type Logger = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
};

export type ChatType = 'private' | 'group';

/** OneBot 发送目标（私聊用户或群）。 */
export type SendTarget =
	| { chatType: 'private'; userId: string }
	| { chatType: 'group'; groupId: string };

/** 从 Cordis Context 上按需取服务（dsh 运行时提供，类型在此收窄）。 */
export function getService<T>(ctx: unknown, name: string): T | undefined {
	try {
		return (ctx as { get(service: string): unknown }).get(name) as T | undefined;
	} catch {
		return undefined;
	}
}

/** Cordis Context 上的 logger（dsh 运行时注入；缺失时退回 console）。 */
export function getLogger(ctx: unknown): Logger {
	const logger = (ctx as { logger?: Partial<Logger> }).logger;
	if (logger && typeof logger.info === 'function' && typeof logger.warn === 'function' && typeof logger.error === 'function') {
		return logger as Logger;
	}
	return {
		info: (message) => console.log(`[dsh-qq-bot] ${message}`),
		warn: (message) => console.warn(`[dsh-qq-bot] ${message}`),
		error: (message) => console.error(`[dsh-qq-bot] ${message}`),
	};
}
