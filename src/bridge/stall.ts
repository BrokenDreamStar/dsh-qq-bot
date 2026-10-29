/**
 * 无进展看门狗（纯逻辑：可注入时钟与 sleep，零 node 依赖）。
 *
 * **为什么不是"总时长超时"**：长任务（编译、下载、批处理）跑几十分钟是正常的，
 * 按总时长取消必然误杀——曾经每轮 10 分钟的 `maxTurnMs` 就是这样把用户的长任务
 * 腰斩的（已按用户要求删除）。真正值得兜底的是"卡死"：模型调用永不返回、agent
 * 提了问没人答、宿主侧死锁。它们的共同表现是**会话事件流不再推进**。
 *
 * 所以判据是 `progress()`（调用方传 `agent.session.seq`：它就是"下一个事件的
 * 序号"，模型的每个 stream chunk、每次 `tool/call` / `tool/result`、每个 step
 * 边界都会让它 +1）在连续 `idleMs` 内一次都没变。只要有进展，跑多久都不打断。
 *
 * 唯一的例外是"在等用户回答"（`waiting()`）：那是**等人**不是卡死，而且提问中继
 * 自己就有 `askUserWaitMs` 预算，不该被看门狗抢跑。
 */

/** `progress()` 的默认轮询间隔（ms）。 */
export const DEFAULT_STALL_POLL_MS = 5_000;
/** 默认的无进展上限（ms）：15 分钟一声不吭才判定卡死。 */
export const DEFAULT_STALL_IDLE_MS = 900_000;

export interface StallGuardOptions {
	/** 无进展上限（ms）；<= 0 = 不监视（守卫永不触发）。 */
	idleMs: number;
	/** 进展信号：值变了就算有动静（会话日志用 `agent.session.seq`）。 */
	progress: () => number;
	/** 轮询间隔（ms），默认 {@link DEFAULT_STALL_POLL_MS}；会被压到 idleMs/4 以内。 */
	pollMs?: number;
	/** 返回 true = 当前在等用户回答（不计入无进展时间）。 */
	waiting?: () => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface StallGuard {
	/** 判定无进展时 resolve；`stop()` 之后永不 resolve。 */
	readonly stalled: Promise<void>;
	/** 是否已经判定为无进展（调用方据此决定"取消本轮"）。 */
	readonly isStalled: boolean;
	/** 停止监视（本轮已正常结束 / 已取消，不该再触发）。 */
	stop(): void;
}

/** 人类可读的时长（提示文案用）：900000 → "15 分钟"。 */
export function describeStallMs(ms: number): string {
	if (ms >= 60_000) {
		const minutes = ms / 60_000;
		return `${Number.isInteger(minutes) ? minutes : Math.round(minutes)} 分钟`;
	}
	return `${Math.max(Math.round(ms / 1000), 1)} 秒`;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 起一个无进展守卫：轮询 `progress()`，连续 `idleMs` 没变化就 resolve `stalled`。
 *
 * 调用方典型用法（见 agentRunner.runTurn）：与 `agent.whenIdle()` 赛跑，
 * `isStalled` 为真时再 `agent.cancel()` 并等它落稳。
 */
export function createStallGuard(options: StallGuardOptions): StallGuard {
	let stopped = false;
	let stalled = false;
	let fire: () => void = () => {};
	const stalledPromise = new Promise<void>((resolve) => {
		fire = resolve;
	});
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const idleMs = Math.floor(options.idleMs);

	if (idleMs > 0) {
		// 至少查几次再判定：轮询间隔不随 idleMs 一起放大到"只查一次"。
		const pollMs = Math.max(Math.min(options.pollMs ?? DEFAULT_STALL_POLL_MS, Math.floor(idleMs / 4)), 50);
		let last = options.progress();
		let lastChangeAt = now();
		const tick = async (): Promise<void> => {
			while (!stopped) {
				await sleep(pollMs);
				if (stopped) return;
				const current = options.progress();
				if (current !== last) {
					last = current;
					lastChangeAt = now();
					continue;
				}
				// 等用户回答不算无进展（等人 ≠ 卡死；中继自己有等待预算）。
				if (options.waiting?.() === true) {
					lastChangeAt = now();
					continue;
				}
				if (now() - lastChangeAt >= idleMs) {
					stalled = true;
					fire();
					return;
				}
			}
		};
		void tick();
	}

	return {
		stalled: stalledPromise,
		get isStalled(): boolean {
			return stalled;
		},
		stop(): void {
			stopped = true;
		},
	};
}
