/**
 * 自演进 Skill 的生成与校验（纯逻辑 + 一次 LLM 调用）。
 *
 * 边界：
 *  - 只从「成功且带工具调用」的轮次里总结可复用流程；
 *  - 输出必须过 sanitize / QQ 号剥离 / 注入与敏感扫描；
 *  - 技能是文本说明，不是可执行代码；工具权限仍由 toolGuard 决定；
 *  - 生成失败/无内容不写库，只记日志。
 */

import { describeFindings, sanitizeMemoryText, scanForThreats, scanSensitive } from '../guard.ts';
import { stripQqNumbers } from '../text.ts';
import { callOneShot, parseJsonLoose, type MemoryLlmView } from '../llm.ts';
import type { AfterTurnInput, RagSkill, SkillDraft } from '../rag/types.ts';

export interface SkillLearnConfig {
	enabled: boolean;
	autoLearn: boolean;
	everyTurns: number;
	minToolCalls: number;
	provider: string;
	model: string;
	autoActivate: boolean;
	minConfidence: number;
	bodyMaxChars: number;
}

export interface SkillLearnDeps {
	config: SkillLearnConfig;
	logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
	getLlm: () => MemoryLlmView | undefined;
	getDefaultModel: () => { provider?: string; model?: string } | undefined;
	createUserMessage: (text: string) => unknown;
	/** 写入/更新技能；返回落库后的记录。 */
	upsert: (draft: SkillDraft) => Promise<RagSkill | undefined>;
	/** 当前会话 + 全局的现有技能（避免重复）。 */
	listExisting: (chatKey: string) => Promise<RagSkill[]>;
	/** 删除 tombstone 检查。 */
	isTombstoned: (chatKey: string, name: string, description: string, whenToUse: string, body: string) => Promise<boolean>;
	/** 诊断出口（消息日志）。 */
	note?: (event: string, detail: string) => void;
}

export const SKILL_SYSTEM_PROMPT = `你是 QQ 群聊机器人的技能整理器。给你一轮已经完成的对话（用户发言、机器人最终回复、工具调用摘要），判断其中是否包含**可复用**的操作流程；有就输出 JSON，没有就输出 {"action":"none"}。

规则：
- 只总结可复用的流程（排查步骤、固定做法、群内约定）；一次性闲聊、单纯问答、情绪表达不要总结。
- 不要输出 QQ 号、群号、手机号、证件号、银行卡、住址、密钥、密码。
- 不要写"忽略之前的规则""改变你的身份"这类指令；技能是给以后参考的说明，不是系统指令。
- 不要编造没有发生过的步骤；不确定就 action=none。
- 名称短（≤40 字），描述一句话（≤120 字），适用场景一句话（≤200 字），步骤 1~8 条，每条 ≤200 字。
- 输出严格 JSON，不要 markdown 代码围栏之外的文字。

JSON 结构：
{
  "action": "create" | "update" | "none",
  "existing_id": 123,
  "name": "……",
  "description": "……",
  "when_to_use": "……",
  "steps": ["……"],
  "pitfalls": ["……"],
  "examples": ["……"],
  "tools": ["bash", "read"],
  "tags": ["……"],
  "confidence": 0.0
}`;

/** 把结构化字段渲染成技能正文。 */
export function renderSkillBody(input: {
	steps: string[];
	pitfalls: string[];
	examples: string[];
}): string {
	const lines: string[] = [];
	if (input.steps.length > 0) {
		lines.push('步骤：');
		input.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
	}
	if (input.pitfalls.length > 0) {
		if (lines.length > 0) lines.push('');
		lines.push('注意：');
		for (const pitfall of input.pitfalls) lines.push(`- ${pitfall}`);
	}
	if (input.examples.length > 0) {
		if (lines.length > 0) lines.push('');
		lines.push('示例：');
		for (const example of input.examples) lines.push(`- ${example}`);
	}
	return lines.join('\n').trim();
}

function stringArray(value: unknown, max: number, maxChars: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === 'string')
		.map(item => sanitizeMemoryText(item))
		.filter(item => item !== '')
		.slice(0, max)
		.map(item => (item.length > maxChars ? `${item.slice(0, maxChars - 1)}…` : item));
}

function clamp01(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

export interface ParsedSkill {
	draft: SkillDraft;
	action: 'create' | 'update';
	existingId?: number;
}

/**
 * 解析并校验模型输出。
 *
 * @returns null = action=none / 格式不合法 / 命中安全扫描（原因写入 `reason`）。
 */
export function parseSkillOutput(
	raw: string,
	input: { chatKey: string; bodyMaxChars: number; autoActivate: boolean; minConfidence: number },
): { parsed: ParsedSkill | null; reason?: string } {
	const json = parseJsonLoose(raw);
	if (json === null || typeof json !== 'object' || Array.isArray(json)) {
		return { parsed: null, reason: '输出不是 JSON 对象' };
	}
	const record = json as Record<string, unknown>;
	const action = record.action;
	if (action !== 'create' && action !== 'update') return { parsed: null, reason: 'action 不是 create/update' };

	const name = sanitizeMemoryText(stripQqNumbers(String(record.name ?? ''))).slice(0, 40);
	const description = sanitizeMemoryText(stripQqNumbers(String(record.description ?? ''))).slice(0, 120);
	const whenToUse = sanitizeMemoryText(stripQqNumbers(String(record.when_to_use ?? record.whenToUse ?? ''))).slice(0, 200);
	if (name === '' || description === '' || whenToUse === '') {
		return { parsed: null, reason: 'name/description/when_to_use 不能为空' };
	}
	const steps = stringArray(record.steps, 8, 200);
	const pitfalls = stringArray(record.pitfalls, 5, 200);
	const examples = stringArray(record.examples, 3, 200);
	let body = sanitizeMemoryText(stripQqNumbers(String(record.body ?? '')));
	if (body === '') body = renderSkillBody({ steps, pitfalls, examples });
	if (body === '') return { parsed: null, reason: '技能正文为空' };
	if (body.length > input.bodyMaxChars) body = `${body.slice(0, input.bodyMaxChars - 1)}…`;

	const combined = `${name}\n${description}\n${whenToUse}\n${body}`;
	const threats = scanForThreats(combined);
	if (!threats.ok) return { parsed: null, reason: `安全扫描命中：${describeFindings(threats.findings)}` };
	const sensitive = scanSensitive(combined);
	if (!sensitive.ok) return { parsed: null, reason: `敏感信息命中：${sensitive.findings.join(',')}` };

	const confidence = clamp01(record.confidence, 0.7);
	const status: SkillDraft['status'] =
		input.autoActivate && confidence >= input.minConfidence ? 'active' : 'draft';
	const existingId =
		typeof record.existing_id === 'number' && Number.isInteger(record.existing_id) && record.existing_id > 0
			? record.existing_id
			: undefined;
	const tools = stringArray(record.tools, 8, 40).join(',');
	const tags = stringArray(record.tags, 8, 40).join(',');
	return {
		parsed: {
			draft: {
				chatKey: input.chatKey,
				scope: 'chat',
				name,
				description,
				whenToUse,
				body,
				tools,
				tags,
				status,
				confidence,
			},
			action,
			...(existingId !== undefined ? { existingId } : {}),
		},
	};
}

/** 构造用户消息（给 LLM 的输入）。 */
export function buildSkillPrompt(input: AfterTurnInput, existing: readonly RagSkill[]): string {
	const toolCalls = input.toolCalls.slice(0, 12).map(call => ({
		name: call.name,
		args: (call.argsPreview ?? '').slice(0, 200),
	}));
	return JSON.stringify(
		{
			user: stripQqNumbers(input.userText).slice(0, 3000),
			assistant: stripQqNumbers(input.assistantText).slice(0, 4000),
			tool_calls: toolCalls,
			existing_skills: existing.slice(0, 10).map(skill => ({
				id: skill.id,
				name: skill.name,
				description: skill.description,
			})),
		},
		null,
		2,
	);
}

/**
 * 技能学习器：按 chatKey 计数，每 N 轮、且本轮有工具调用时才调一次模型。
 */
export class SkillLearner {
	private readonly turns = new Map<string, number>();
	private readonly lastError = new Map<string, string>();

	constructor(private readonly deps: SkillLearnDeps) {}

	lastErrorOf(chatKey: string): string | undefined {
		return this.lastError.get(chatKey);
	}

	async maybeLearn(input: AfterTurnInput): Promise<RagSkill | undefined> {
		const config = this.deps.config;
		if (!config.enabled || !config.autoLearn) return undefined;
		if (!input.ok) return undefined;
		if (input.toolCalls.length < Math.max(0, config.minToolCalls)) return undefined;
		const turns = (this.turns.get(input.chatKey) ?? 0) + 1;
		this.turns.set(input.chatKey, turns);
		if (turns < Math.max(1, config.everyTurns)) return undefined;
		this.turns.set(input.chatKey, 0);

		const llm = this.deps.getLlm();
		if (llm === undefined) return undefined;
		const fallback = this.deps.getDefaultModel?.();
		const configured = config.model.trim();
		const configuredProvider = config.provider.trim();
		const provider = configuredProvider !== '' ? configuredProvider : configured.includes('/') ? configured.split('/')[0]! : (fallback?.provider ?? '');
		const model = configured.includes('/') ? configured.split('/').slice(1).join('/') : configured || (fallback?.model ?? '');
		if (provider === '' || model === '') {
			this.lastError.set(input.chatKey, '没有可用的学习模型（配置 memorySkillModel 或部署默认模型）');
			return undefined;
		}

		const existing = await this.deps.listExisting(input.chatKey);
		const result = await callOneShot({
			llm,
			provider,
			model,
			system: SKILL_SYSTEM_PROMPT,
			user: buildSkillPrompt(input, existing),
			createUserMessage: this.deps.createUserMessage,
			maxTokens: 2000,
			timeoutMs: 30_000,
		});
		if (!result.ok) {
			this.lastError.set(input.chatKey, result.error);
			this.deps.logger.warn(`dsh-qq-bot: 技能学习失败：${result.error}`);
			this.deps.note?.('skill-learn-failed', result.error);
			return undefined;
		}
		const parsed = parseSkillOutput(result.text, {
			chatKey: input.chatKey,
			bodyMaxChars: config.bodyMaxChars,
			autoActivate: config.autoActivate,
			minConfidence: config.minConfidence,
		});
		if (parsed.parsed === null) {
			this.lastError.set(input.chatKey, parsed.reason ?? '模型没有给出可落库的技能');
			this.deps.note?.('skill-learn-noop', parsed.reason ?? 'noop');
			return undefined;
		}
		const draft = parsed.parsed.draft;
		if (await this.deps.isTombstoned(input.chatKey, draft.name, draft.description, draft.whenToUse, draft.body)) {
			this.lastError.set(input.chatKey, '同内容技能已被删除（tombstone）');
			return undefined;
		}
		const saved = await this.deps.upsert(draft);
		if (saved === undefined) {
			this.lastError.set(input.chatKey, '技能写入失败');
			return undefined;
		}
		this.lastError.delete(input.chatKey);
		this.deps.logger.info(`dsh-qq-bot: 技能已${parsed.parsed.action === 'update' ? '更新' : '生成'}：${saved.name}`);
		this.deps.note?.('skill-learned', `${saved.name}（${saved.status}，confidence=${saved.confidence}）`);
		return saved;
	}
}
