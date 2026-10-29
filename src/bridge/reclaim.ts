/**
 * 写句柄占用的应对策略（纯逻辑，可注入时钟与等待函数，便于单测）。
 *
 * 背景：dsh 会话是**单写者模型**——同一 session id 在进程内只允许一个活动
 * 写句柄（`SessionAlreadyOwnedError`）。插件想 resume 时可能撞上两种情况：
 *
 *  1. 本插件上一个 handle 正在销毁（/reset、/model 重建、进程重启后的残留），
 *     顶多多等一两秒，退避重试即可恢复；
 *  2. **dsh 界面（WebUI / TUI）把这个会话打开了**：宿主 sessionController
 *     持有写句柄，且不会自行释放（关标签页、空闲都不会）。
 *
 * 现在默认不再轮换：先尝试从原会话 **fork** 一个新会话（完整继承事件前缀，
 * 见 bridge/chat.ts 的 forkHeldSession），既保留上下文，又不用抢对方的写句柄。
 * `wait` 仍保留给"我就想等界面关掉、继续原会话"的场景；`rotate` 只作为 fork
 * 失败后的最后兜底（或用户明确要求"重新开始"）。
 *
 * 本模块只做决策与轮询，不碰 dsh API；真正的 resume/fork 在 ChatBridge.openAgent。
 */

/** 占用时的策略：fork = 从原会话分叉（默认）；wait = 等对方释放；rotate = 立即换新会话。 */
export type BusyStrategy = 'fork' | 'wait' | 'rotate';

/** 策略取值（Web UI 下拉与 schema 共用）。 */
export const BUSY_STRATEGIES = ['fork', 'wait', 'rotate'] as const;

export const DEFAULT_BUSY_STRATEGY: BusyStrategy = 'fork';

/** 默认等待上限（ms）：等不到就走 fork，避免无限期押后消息。 */
export const DEFAULT_BUSY_WAIT_MS = 300_000;

/** 配置里出现未知值时保守回落到「分叉」——分叉保留上下文，不会静默丢对话。 */
export function normalizeBusyStrategy(value: unknown): BusyStrategy {
	if (value === 'rotate') return 'rotate';
	if (value === 'wait') return 'wait';
	if (value === 'fork') return 'fork';
	return DEFAULT_BUSY_STRATEGY;
}

/**
 * 空闲回收该不该开着：`sessionIdleTimeoutMs > 0` 才回收，**0 = 插件建立的会话
 * 永不回收**（写句柄一直留在插件手里，dsh 界面只能复用同一个 agent）。
 * 纯判定，供 `ChatBridgeManager.reconfigureEviction` 与单测共用。
 */
export function shouldEvictIdleSessions(idleTimeoutMs: number): boolean {
	return idleTimeoutMs > 0;
}

/**
 * `waitOnBusy: false`（启动预热、只读的 `/status`）撞上占用时抛出的错误：
 * 让调用方能区分"句柄在界面手里"（正常状态，只是这次占不到）与真正的失败。
 */
export class SessionBusyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SessionBusyError';
	}
}

/** 会话写句柄当前在谁手里。 */
export type HandleDisposition = 'none' | 'ours' | 'other';

export interface HandleDispositionInput {
	/** 本桥当前是否持有该会话的 handle。 */
	hasLocalHandle: boolean;
	/** 宿主 agent 注册表里是否有该会话的活 agent（本桥之外 = 其它界面持有）。 */
	hostHasLiveAgent: boolean;
}

export function handleDisposition(input: HandleDispositionInput): HandleDisposition {
	if (input.hasLocalHandle) return 'ours';
	return input.hostHasLiveAgent ? 'other' : 'none';
}

/** /status 用的一行说明。 */
export function describeDisposition(disposition: HandleDisposition): string {
	switch (disposition) {
		case 'ours':
			return '本插件持有（其它界面只能复用同一个 agent）';
		case 'other':
			return '被其它界面持有（下一条消息按 busyStrategy 分叉/等待/换新会话）';
		default:
			return '未打开（下一条消息建立）';
	}
}

/** 提示分两段：刚发现被占（用户还有机会去关界面），与真的换/分叉了（说明原因）。 */
export const HELD_NOTICE = '（这个会话正开在 dsh 界面里，写句柄被它占着；我先等一会儿。关掉那边的会话后重发即可继续，不用新开会话）';
export const HELD_ROTATED_NOTICE = '（原会话被 dsh 界面占用或无法分叉，已开启新会话；旧会话历史保留，可在界面里查看）';
export const FORKED_NOTICE = '（这个会话正开在 dsh 界面里，已从当前上下文分叉出新会话继续；旧会话保留，界面里仍可查看）';

/**
 * 轮询等待对方释放写句柄。
 *
 * 前 `probeAttempts` 次用短退避（覆盖"自己的旧 handle 正在销毁"这类瞬时
 * 情况），之后按 `pollMs` 稳速轮询到 `deadlineMs`；`isCanceled` 每轮求值，
 * 供 `/reset`、桥销毁、显式接管请求随时打断。
 *
 * @param release 每轮调用一次；返回 true = 句柄已拿到（调用方负责真正 resume）
 * @returns 拿到句柄 / 超时 / 被打断
 */
export async function waitForHandleRelease(
	release: () => Promise<boolean>,
	options: {
		deadlineMs: number;
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		probeDelaysMs?: readonly number[];
		pollMs?: number;
		isCanceled?: () => boolean;
	},
): Promise<'released' | 'deadline' | 'canceled'> {
	const probes = options.probeDelaysMs ?? [];
	const pollMs = options.pollMs ?? 5_000;
	for (let attempt = 0; ; attempt += 1) {
		if (options.isCanceled?.() === true) return 'canceled';
		try {
			if (await release()) return 'released';
		} catch {
			// 仍未释放：继续等（真正无法恢复的错误由调用方在这一轮之外处理）。
		}
		if (options.isCanceled?.() === true) return 'canceled';
		const remaining = options.deadlineMs - options.now();
		if (remaining <= 0) return 'deadline';
		const delay = attempt < probes.length ? probes[attempt]! : pollMs;
		await options.sleep(Math.min(delay, remaining));
	}
}
