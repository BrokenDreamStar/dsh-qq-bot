/**
 * 模型规格的解析与展示（纯逻辑，可测）。
 *
 * 模型来自两处，都会归一为 `provider/model` 文本后交给 dsh：
 *  - WebUI「人格与模型」表格的模型下拉（宿主 RPC 写入 chat-overrides.json）；
 *  - 会话内 `/model provider/model` 命令。
 *
 * 生效优先级（高 → 低）：
 *   1. 会话内 `/model` 覆盖 / WebUI 表格里该号码的模型（同一份存储）
 *   2. WebUI「人格与模型」卡片「默认会话」行的模型
 *   3. dsh 部署默认模型
 */

/** 模型规格：`provider/model` 或仅 `model`（provider 缺省 = 用部署默认 provider）。 */
export interface ModelSpec {
	provider?: string;
	model: string;
}

/** 解析模型规格文本；空串或残缺的 `provider/`、`/model` 返回 null。 */
export function parseModelSpec(spec: string): ModelSpec | null {
	const trimmed = spec.trim();
	if (trimmed === '') return null;
	const slash = trimmed.indexOf('/');
	if (slash < 0) return { model: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	if (provider === '' || model === '') return null;
	return { provider, model };
}

/** 模型规格 → 文本；缺 model 时返回空串（= 未指定，用部署默认）。 */
export function formatModelSpec(spec: { provider?: string; model?: string }): string {
	if (spec.model === undefined || spec.model === '') return '';
	return spec.provider !== undefined && spec.provider !== '' ? `${spec.provider}/${spec.model}` : spec.model;
}

export type ModelSource =
	/** 会话内 /model 覆盖或 WebUI「人格与模型」表格里的模型。 */
	| { kind: 'chatOverride' }
	/** WebUI「人格与模型」卡片「默认会话」行的模型。 */
	| { kind: 'configDefault' }
	/** dsh 部署默认模型。 */
	| { kind: 'default' };

export interface ResolvedChatModel {
	/** 未指定 = 用部署默认。 */
	model?: ModelSpec;
	source: ModelSource;
}

/** 解析某会话的生效模型（会话/号码行 > 默认会话行 > 部署默认）。 */
export function resolveChatModel(input: { override?: string; configDefault?: string }): ResolvedChatModel {
	if (input.override !== undefined && input.override !== '') {
		const model = parseModelSpec(input.override);
		if (model !== null) return { model, source: { kind: 'chatOverride' } };
	}
	if (input.configDefault !== undefined && input.configDefault !== '') {
		const model = parseModelSpec(input.configDefault);
		if (model !== null) return { model, source: { kind: 'configDefault' } };
	}
	return { source: { kind: 'default' } };
}

/** 来源的中文描述（/model、/status 与日志用）。 */
export function describeModelSource(source: ModelSource): string {
	if (source.kind === 'chatOverride') return '本会话 /model 或 WebUI 模型配置';
	if (source.kind === 'configDefault') return 'WebUI「人格与模型」默认会话行';
	return 'dsh 部署默认';
}
