/**
 * 人格库：JSON 文件持久化（<dataDir>/personas.json），
 * 支持按会话覆盖人格与模型（<dataDir>/chat-overrides.json）。
 *
 * 注入方式：agent setup 时通过 agentCtx.systemPrompt.section 挂载，
 * 切换人格/模型后 dispose 当前 handle（保留会话历史），下一条消息
 * 重新 ensureAgent 时以新配置实例化。
 *
 * 两处写入来源共用同一份数据：
 *  - WebUI「人格库」「人格与模型」卡片（走宿主 RPC，整表替换）；
 *  - 会话内 /persona、/model 命令（单键覆盖）。
 *
 * 生效优先级（高 → 低）：
 *  1. 会话精确键（命令写入）
 *  2. 号码级键（`u-<QQ号>` / `g-<群号>`，「人格与模型」表格行）
 *  3. 「默认会话」行（`chat-overrides.json` 的 `default` 保留键）
 *  4. 人格库默认人格（personas.json 的 `default` / 第一个）/ dsh 部署默认模型
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../types.ts';
import { isChatSelectorKey } from './routes.ts';

export interface PersonaEntry {
	prompt: string;
}

interface PersonasFile {
	default?: string;
	personas?: Record<string, PersonaEntry>;
}

export interface ChatOverride {
	persona?: string;
	model?: string;
}

/** 人格库条目（WebUI 列表用，保留文件里的顺序）。 */
export interface PersonaRecord {
	name: string;
	prompt: string;
}

/** 「人格与模型」表格一行（chat 为 `friend_<QQ号>` / `group_<群号>`）。 */
export interface ChatMapping {
	key: string;
	persona?: string;
	model?: string;
}

export const DEFAULT_PERSONA_NAME = 'default';

/**
 * 「默认会话」行在 chat-overrides.json 里的保留键：WebUI「人格与模型」卡片第一行
 * （左侧固定文案「默认会话」）写在这里，作用于所有没有单独配置的会话。
 * 它不是号码级选择器键（`isChatSelectorKey` 为假），所以 `setMappings`
 * 整表替换号码行时会原样保留、`mappings()` 也不会把它当普通行回显。
 */
export const DEFAULT_MAPPING_KEY = 'default';

const DEFAULT_PERSONA_PROMPT = [
	'你是 QQ 里的 AI 助手，由 dsh（DeepSeek Harness）驱动。',
	'用对方的语言聊（通常是中文），像朋友聊天：口语、简短、直接，别端着。',
	'QQ 消息忌长篇大论：先说结论，再补关键信息，少用列表、标题和加粗。',
	'你带 dsh 的全套工具（文件、Shell、联网等），需要时再用。',
	'长任务别闷头跑完才吭声：可以用 qq_send 分段汇报进度，有不确定的就问。',
].join('\n');

export class PersonaStore {
	private file: PersonasFile = {};
	private overrides: Record<string, ChatOverride> = {};
	private readonly personasPath: string;
	private readonly overridesPath: string;

	constructor(
		dataDir: string,
		private readonly logger: Logger,
	) {
		this.personasPath = join(dataDir, 'personas.json');
		this.overridesPath = join(dataDir, 'chat-overrides.json');
	}

	/** 初始化目录与默认人格文件（幂等）。 */
	init(): void {
		try {
			mkdirSync(join(this.personasPath, '..'), { recursive: true });
			if (!existsSync(this.personasPath)) {
				this.file = { default: DEFAULT_PERSONA_NAME, personas: { [DEFAULT_PERSONA_NAME]: { prompt: DEFAULT_PERSONA_PROMPT } } };
				this.savePersonas();
			}
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 初始化人格库失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.load();
	}

	private load(): void {
		try {
			const parsed = JSON.parse(readFileSync(this.personasPath, 'utf8')) as PersonasFile;
			this.file = parsed !== null && typeof parsed === 'object' ? parsed : {};
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 读取 personas.json 失败（使用内置默认人格）: ${error instanceof Error ? error.message : String(error)}`);
			this.file = {};
		}
		try {
			const parsed = JSON.parse(readFileSync(this.overridesPath, 'utf8')) as Record<string, ChatOverride>;
			this.overrides = parsed !== null && typeof parsed === 'object' ? parsed : {};
		} catch {
			this.overrides = {};
		}
	}

	private savePersonas(): void {
		try {
			writeFileSync(this.personasPath, `${JSON.stringify(this.file, null, 2)}\n`, 'utf8');
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写 personas.json 失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private saveOverrides(): void {
		try {
			writeFileSync(this.overridesPath, `${JSON.stringify(this.overrides, null, 2)}\n`, 'utf8');
		} catch (error) {
			this.logger.warn(`dsh-qq-bot: 写 chat-overrides.json 失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ── 人格库 ──

	list(): string[] {
		return Object.keys(this.file.personas ?? {});
	}

	/** 人格库全量（顺序与文件键顺序一致）。 */
	records(): PersonaRecord[] {
		return Object.entries(this.file.personas ?? {}).map(([name, entry]) => ({ name, prompt: entry.prompt ?? '' }));
	}

	defaultPersonaName(): string {
		const names = this.list();
		const configured = this.file.default;
		if (configured !== undefined && configured !== '' && names.includes(configured)) return configured;
		return names[0] ?? DEFAULT_PERSONA_NAME;
	}

	/**
	 * 整表替换人格库（WebUI「人格库」卡片保存）。
	 * 空名条目被丢弃；重名后者覆盖前者；默认名落到实际存在的条目上。
	 *
	 * WebUI 已不再提供「默认」单选（默认人格改在「人格与模型」卡片的
	 * 「默认会话」行里配），`defaultName` 传 null 时**保留原默认**，
	 * 免得用户改一条提示词就把老部署选过的默认人格悄悄换成第一个。
	 */
	setLibrary(records: readonly PersonaRecord[], defaultName: string | null): void {
		const personas: Record<string, PersonaEntry> = {};
		for (const record of records) {
			const name = record.name.trim();
			if (name === '') continue;
			personas[name] = { prompt: record.prompt };
		}
		const byName = new Map(records.map((record) => [record.name.trim(), record]));
		const previous = this.defaultPersonaName();
		this.file = { personas };
		const named = defaultName?.trim() ?? '';
		if (named !== '' && byName.has(named)) {
			this.file.default = named;
		} else if (Object.hasOwn(personas, previous)) {
			this.file.default = previous;
		} else if (Object.hasOwn(personas, DEFAULT_PERSONA_NAME)) {
			this.file.default = DEFAULT_PERSONA_NAME;
		} else {
			const first = Object.keys(personas)[0];
			if (first !== undefined) this.file.default = first;
		}
		this.savePersonas();
	}

	// ── 会话覆盖 ──

	/** 把「确切 chatKey」或「号码级键」的候选列表归一为数组。 */
	private keyList(keys: string | readonly string[]): readonly string[] {
		return typeof keys === 'string' ? [keys] : keys;
	}

	/**
	 * 解析某会话生效的人格：会话精确覆盖 > 号码级映射 > 「默认会话」行 > 库默认 > 内置。
	 * keys 依次尝试：`[chatKey, 号码级键]`（perUser 群会话才需要第二个）。
	 */
	resolve(keys: string | readonly string[]): { name: string; prompt: string } {
		const list = this.keyList(keys);
		const personas = this.file.personas ?? {};
		let overrideName: string | undefined;
		for (const key of list) {
			const name = this.overrides[key]?.persona;
			if (name !== undefined && name !== '' && personas[name] !== undefined) {
				overrideName = name;
				break;
			}
		}
		if (overrideName !== undefined) return { name: overrideName, prompt: personas[overrideName]!.prompt };
		const rowPersona = this.overrides[DEFAULT_MAPPING_KEY]?.persona;
		if (rowPersona !== undefined && rowPersona !== '' && personas[rowPersona] !== undefined) {
			return { name: rowPersona, prompt: personas[rowPersona]!.prompt };
		}
		const defaultName = this.defaultPersonaName();
		if (personas[defaultName] !== undefined) return { name: defaultName, prompt: personas[defaultName]!.prompt };
		return { name: defaultName, prompt: DEFAULT_PERSONA_PROMPT };
	}

	setChatPersona(chatKey: string, persona: string | null): void {
		this.setOverride(chatKey, 'persona', persona);
	}

	/**
	 * 某会话生效的模型覆盖文本：会话精确覆盖 > 号码级映射。
	 * keys 与 resolve 一致；未配置返回 undefined（= 用部署默认）。
	 */
	getChatModel(keys: string | readonly string[]): string | undefined {
		for (const key of this.keyList(keys)) {
			const model = this.overrides[key]?.model;
			if (model !== undefined && model !== '') return model;
		}
		return undefined;
	}

	setChatModel(chatKey: string, model: string | null): void {
		this.setOverride(chatKey, 'model', model);
	}

	// ── 「默认会话」行 ──

	/** 「默认会话」行（显式配置的那部分；未配置返回 null）。 */
	defaultMapping(): ChatMapping | null {
		const override = this.overrides[DEFAULT_MAPPING_KEY];
		if (override === undefined) return null;
		const row: ChatMapping = { key: DEFAULT_MAPPING_KEY };
		if (override.persona !== undefined && override.persona !== '') row.persona = override.persona;
		if (override.model !== undefined && override.model !== '') row.model = override.model;
		return row.persona === undefined && row.model === undefined ? null : row;
	}

	/** 写入「默认会话」行（WebUI 第一行）；空行 = 清除。 */
	setDefaultMapping(row: ChatMapping | null): void {
		const override: ChatOverride = {};
		if (row !== null) {
			const persona = row.persona?.trim() ?? '';
			const model = row.model?.trim() ?? '';
			if (persona !== '') override.persona = persona;
			if (model !== '') override.model = model;
		}
		if (Object.keys(override).length === 0) delete this.overrides[DEFAULT_MAPPING_KEY];
		else this.overrides[DEFAULT_MAPPING_KEY] = override;
		this.saveOverrides();
	}

	/** 「默认会话」行配置的模型；未配置返回 undefined（= 用 dsh 部署默认）。 */
	defaultModel(): string | undefined {
		const model = this.overrides[DEFAULT_MAPPING_KEY]?.model;
		return model !== undefined && model !== '' ? model : undefined;
	}

	private setOverride(chatKey: string, field: keyof ChatOverride, value: string | null): void {
		const override = { ...(this.overrides[chatKey] ?? {}) };
		if (value === null || value === '') delete override[field];
		else override[field] = value;
		if (Object.keys(override).length === 0) delete this.overrides[chatKey];
		else this.overrides[chatKey] = override;
		this.saveOverrides();
	}

	/** 号码级映射行（`u-<QQ号>` / `g-<群号>`）；perUser 会话键不在此列。 */
	mappings(): ChatMapping[] {
		const rows: ChatMapping[] = [];
		for (const [key, override] of Object.entries(this.overrides)) {
			if (!isChatSelectorKey(key)) continue;
			const row: ChatMapping = { key };
			if (override.persona !== undefined && override.persona !== '') row.persona = override.persona;
			if (override.model !== undefined && override.model !== '') row.model = override.model;
			if (row.persona === undefined && row.model === undefined) continue;
			rows.push(row);
		}
		return rows;
	}

	/**
	 * 整表替换号码级映射（WebUI「人格与模型」卡片保存）：
	 * 只动号码级键，perUser 群会话键（命令写入）与「默认会话」保留键原样保留。
	 */
	setMappings(rows: readonly ChatMapping[]): void {
		const next: Record<string, ChatOverride> = {};
		for (const [key, override] of Object.entries(this.overrides)) {
			if (!isChatSelectorKey(key)) next[key] = override;
		}
		for (const row of rows) {
			if (!isChatSelectorKey(row.key)) continue;
			const override: ChatOverride = {};
			if (row.persona !== undefined && row.persona !== '') override.persona = row.persona;
			if (row.model !== undefined && row.model !== '') override.model = row.model;
			if (override.persona === undefined && override.model === undefined) continue;
			next[row.key] = override;
		}
		this.overrides = next;
		this.saveOverrides();
	}
}
