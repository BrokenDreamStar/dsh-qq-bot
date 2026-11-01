/**
 * 一次性 LLM 调用（技能总结用）。
 *
 * 与旧蒸馏相同的原则：走 `ctx.llm.stream()`，不 fork agent、不产生额外会话文件。
 * 推理模型可能把预算烧在思考上，所以空输出时按 4 倍预算重试一档；仍空则报错。
 */

export interface MemoryLlmView {
	stream(options: {
		provider: string;
		model: string;
		system?: string;
		messages: unknown[];
		maxTokens?: number;
		temperature?: number;
		reasoningEffort?: string;
		signal?: AbortSignal;
	}): AsyncIterable<{ type: string; text?: string; reason?: unknown; usage?: unknown }>;
	resolveModelInfo?(
		provider: string,
		model: string,
		signal?: AbortSignal,
	): Promise<{ reasoning?: { efforts?: Array<{ id?: string; name?: string }>; defaultEffort?: string } } | undefined>;
}

export interface OneShotOptions {
	llm: MemoryLlmView;
	provider: string;
	model: string;
	system: string;
	user: string;
	createUserMessage: (text: string) => unknown;
	maxTokens?: number;
	timeoutMs?: number;
}

const EFFORT_ORDER = ['off', 'none', 'disabled', 'minimal', 'low', 'medium', 'high', 'max'];

function finishKind(reason: unknown): string {
	if (typeof reason === 'string') return reason;
	if (reason !== null && typeof reason === 'object') {
		const kind = (reason as { kind?: unknown }).kind;
		if (typeof kind === 'string') return kind;
	}
	return '';
}

function outputTokens(usage: unknown): number | undefined {
	if (usage === null || typeof usage !== 'object') return undefined;
	const value = (usage as { outputTokens?: unknown }).outputTokens;
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function pickEffort(llm: MemoryLlmView, provider: string, model: string): Promise<string | undefined> {
	if (typeof llm.resolveModelInfo !== 'function') return undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);
	try {
		const info = await llm.resolveModelInfo(provider, model, controller.signal);
		const ids = (info?.reasoning?.efforts ?? [])
			.map(effort => (typeof effort?.id === 'string' ? effort.id : ''))
			.filter(id => id !== '');
		if (ids.length === 0) return undefined;
		for (const wanted of EFFORT_ORDER) {
			const hit = ids.find(id => id.toLowerCase() === wanted);
			if (hit !== undefined) return hit;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 调用一次 LLM，返回可见文本。
 *
 * 预算阶梯：首轮 `maxTokens`；空输出且 `finish=max-tokens`（或输出 token 几乎吃满）
 * 时用 4 倍预算再试一次；仍空返回失败原因。
 */
export async function callOneShot(options: OneShotOptions): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const effort = await pickEffort(options.llm, options.provider, options.model);
	const first = Math.max(128, Math.trunc(options.maxTokens ?? 2000));
	const budgets = [first, Math.min(32_768, first * 4)];
	let lastError = '';
	for (const [index, budget] of budgets.entries()) {
		const controller = new AbortController();
		const timeoutMs = Math.max(1000, Math.trunc(options.timeoutMs ?? 30_000)) * (index === 0 ? 1 : 2);
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let text = '';
		let finish = '';
		let tokens: number | undefined;
		try {
			const stream = options.llm.stream({
				provider: options.provider,
				model: options.model,
				system: options.system,
				messages: [options.createUserMessage(options.user)],
				maxTokens: budget,
				temperature: 0,
				...(effort !== undefined ? { reasoningEffort: effort } : {}),
				signal: controller.signal,
			});
			for await (const chunk of stream) {
				if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
				if (chunk.type === 'finish') finish = finishKind(chunk.reason);
				if (chunk.type === 'usage') {
					const output = outputTokens(chunk.usage);
					if (output !== undefined) tokens = output;
				}
			}
		} catch (error) {
			lastError = controller.signal.aborted
				? `调用超时（${timeoutMs}ms）已中止`
				: error instanceof Error
					? error.message
					: String(error);
			clearTimeout(timer);
			continue;
		}
		clearTimeout(timer);
		if (text.trim() !== '') return { ok: true, text: text.trim() };
		lastError = `模型没有可见输出（budget=${budget}，finish=${finish || '未知'}，输出 token=${tokens ?? '未知'}）`;
		if (index === budgets.length - 1) break;
	}
	return { ok: false, error: lastError || '模型没有可见输出' };
}

/** 从模型输出里提取 JSON（容忍 ```json 围栏与前后废话）。 */
export function parseJsonLoose(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	const candidate = fenced?.[1]?.trim() ?? trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf('{');
		const end = candidate.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1));
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}
