/**
 * 人格模板 / 会话人格（SOUL.md）/ 会话模型设置 / 模型清单的宿主 RPC 端点。
 *
 * 数据不走 dsh settings 文档，而是插件的 dataDir 文件（personas.json /
 * chat-overrides.json）与各会话目录的 SOUL.md：保存后所有会话桥丢弃
 * handle，下一条消息以新会话模型设置重建，历史保留。
 *
 * 返回 undefined 表示端点不属于本模块（调用方继续尝试其它端点）。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../types.ts';
import type { LlmServiceLike } from '../dsh.ts';
import { providerId } from '../dsh.ts';
import { formatChatSelector, parseChatSelector } from './routes.ts';
import type { ChatOption } from './chatList.ts';
import { DEFAULT_MAPPING_KEY } from './store.ts';
import type { ChatMapping, PersonaRecord, PersonaStore } from './store.ts';
import { MAX_SOUL_CHARS, inspectSoul, soulPath, writeSoulText } from './soul.ts';
import { sessionDirFor } from '../bridge/chat.ts';

export type PersonaRpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

/** 思考强度选项（dsh 适配器自有的 id + 显示名）。 */
export interface ModelEffortOption {
	id: string;
	name: string;
	description?: string;
}

/** WebUI 模型下拉的选项（spec 即 `provider/model`）。 */
export interface ModelOption {
	spec: string;
	provider: string;
	model: string;
	/** 模型显示名（catalog 未提供时等于 model）。 */
	name: string;
	/** 该模型可选的思考强度（空 = 模型不支持或旧宿主没有元数据）。 */
	efforts: ModelEffortOption[];
	/** 适配器默认强度；空 = 交给模型/适配器默认。 */
	defaultEffort?: string;
	/** 是否是部署默认模型（模型留空时客户端用它的强度清单）。 */
	isDefault?: boolean;
}

export interface PersonaRpcDeps {
	store: PersonaStore;
	/** 会话目录根（`<dataDir>/sessions`），用于扫描 SOUL.md。 */
	sessionsRoot: string;
	/** 惰性取 ctx.llm 服务（可选服务，装载顺序不定，不能构造时快照）。 */
	getLlm?: () => LlmServiceLike | undefined;
	/** 部署默认模型（清单里补一项并置顶）。 */
	getDefaultModel?: () => { provider?: string; model?: string };
	/** 「会话模型设置」的会话下拉（群 / 好友 + 已有会话）；缺省 = 只能手填号码。 */
	listChats?: () => Promise<ChatOption[]>;
	/** 保存后重建所有会话桥（保留历史，下一轮以新配置实例化）。 */
	refreshBridges: () => Promise<void>;
	logger: Logger;
}

const MAX_PERSONAS = 100;
const MAX_NAME_CHARS = 64;
const MAX_PROMPT_CHARS = 20000;
const MAX_ROWS = 200;

const ok = (value: unknown): PersonaRpcResult => ({ ok: true, value });
const fail = (code: string, message: string): PersonaRpcResult => ({ ok: false, error: { code, message } });

function asRecord(payload: unknown): Record<string, unknown> {
	return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 枚举可用模型：llm catalog（provider 分组）+ 部署默认。 */
export async function listModelOptions(deps: Pick<PersonaRpcDeps, 'getLlm' | 'getDefaultModel' | 'logger'>): Promise<ModelOption[]> {
	const options: ModelOption[] = [];
	const seen = new Set<string>();
	const push = (provider: string, model: string, name?: string, isDefault = false): void => {
		const spec = `${provider}/${model}`;
		if (seen.has(spec)) return;
		seen.add(spec);
		options.push({ spec, provider, model, name: name !== undefined && name !== '' ? name : model, efforts: [], ...(isDefault ? { isDefault: true } : {}) });
	};
	const preset = deps.getDefaultModel?.();
	if (preset?.provider !== undefined && preset.model !== undefined && preset.provider !== '' && preset.model !== '') {
		push(preset.provider, preset.model, undefined, true);
	}
	const llm = deps.getLlm?.();
	if (llm !== undefined) {
		try {
			for (const entry of llm.listProviders()) {
				const provider = providerId(entry);
				if (provider === '') continue;
				try {
					const models = await llm.listModels(provider);
					for (const model of models) push(provider, model.id, model.name);
				} catch (error) {
					deps.logger.warn(`dsh-qq-bot: 枚举 ${provider} 的模型失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} catch (error) {
			deps.logger.warn(`dsh-qq-bot: 枚举模型 provider 失败: ${error instanceof Error ? error.message : String(error)}`);
		}
		// 第二遍：补每个模型的思考强度（resolveModelInfo 是适配器元数据，不产生请求；
		// 旧宿主没有这个方法时整列留空 = 用模型默认）。
		if (typeof llm.resolveModelInfo === 'function') {
			for (const option of options) {
				try {
					const info = await llm.resolveModelInfo(option.provider, option.model);
					const efforts = info?.reasoning?.efforts ?? [];
					option.efforts = efforts.map((effort) => ({
						id: effort.id,
						name: effort.name !== undefined && effort.name !== '' ? effort.name : effort.id,
						...(effort.description === undefined ? {} : { description: effort.description }),
					}));
					if (info?.reasoning?.defaultEffort !== undefined && info.reasoning.defaultEffort !== '') option.defaultEffort = info.reasoning.defaultEffort;
				} catch (error) {
					deps.logger.warn(`dsh-qq-bot: 读取 ${option.spec} 的思考强度失败: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}
	return options;
}

function parsePersonaRecords(input: unknown): { records: PersonaRecord[] } | { error: string } {
	if (!Array.isArray(input)) return { error: 'personas 必须是数组' };
	if (input.length > MAX_PERSONAS) return { error: `人格数量不能超过 ${MAX_PERSONAS}` };
	const records: PersonaRecord[] = [];
	for (const raw of input) {
		const entry = asRecord(raw);
		const name = nonEmptyString(entry.name);
		if (name === undefined) return { error: '人格名称不能为空' };
		if (name.length > MAX_NAME_CHARS) return { error: `人格名称不能超过 ${MAX_NAME_CHARS} 字` };
		const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
		if (prompt.length > MAX_PROMPT_CHARS) return { error: `人格提示词不能超过 ${MAX_PROMPT_CHARS} 字` };
		records.push({ name, prompt });
	}
	return { records };
}

/** 校验并规范化「会话模型设置」表格行；非法行返回错误。 */
export function parseMappingRows(input: unknown): { rows: ChatMapping[]; invalid: string[] } {
	if (!Array.isArray(input)) return { rows: [], invalid: ['rows 必须是数组'] };
	const byKey = new Map<string, ChatMapping>();
	const invalid: string[] = [];
	for (const raw of input.slice(0, MAX_ROWS)) {
		const entry = asRecord(raw);
		const chat = typeof entry.chat === 'string' ? entry.chat : '';
		const selector = parseChatSelector(chat);
		if (selector === null) {
			invalid.push(chat === '' ? '(空)' : chat);
			continue;
		}
		const row: ChatMapping = { key: selector.key };
		const persona = nonEmptyString(entry.persona);
		const model = nonEmptyString(entry.model);
		const effort = nonEmptyString(entry.effort);
		if (persona !== undefined) row.persona = persona;
		if (model !== undefined) row.model = model;
		if (effort !== undefined) row.effort = effort;
		byKey.set(row.key, row);
	}
	return { rows: [...byKey.values()], invalid };
}

/** 表格行 → 浏览器面（chat 恢复成 `friend_`/`group_` 写法；人格列已并入「人格」卡，不再回显）。 */
function toRowViews(rows: readonly ChatMapping[]): Array<{ chat: string; model?: string; effort?: string }> {
	return rows.map((row) => {
		const chat = formatChatSelector(row.key) ?? row.key;
		return {
			chat,
			...(row.model === undefined ? {} : { model: row.model }),
			...(row.effort === undefined ? {} : { effort: row.effort }),
		};
	});
}

/**
 * 「默认会话」行 → 浏览器面；未配置返回 `{}`（两个下拉都留空）。
 * `chat` 字段固定为「默认会话」，客户端据此渲染第一行。
 */
function toDefaultView(row: ChatMapping | null): { model?: string; effort?: string } {
	return {
		...(row?.model === undefined ? {} : { model: row.model }),
		...(row?.effort === undefined ? {} : { effort: row.effort }),
	};
}

/** 浏览器面的「默认会话」行 → 存储行（非空字符串才保留；无内容 = 清除）。 */
function parseDefaultMapping(input: unknown): ChatMapping | null {
	const entry = asRecord(input);
	const row: ChatMapping = { key: DEFAULT_MAPPING_KEY };
	const persona = nonEmptyString(entry.persona);
	const model = nonEmptyString(entry.model);
	const effort = nonEmptyString(entry.effort);
	if (persona !== undefined) row.persona = persona;
	if (model !== undefined) row.model = model;
	if (effort !== undefined) row.effort = effort;
	return row.persona === undefined && row.model === undefined && row.effort === undefined ? null : row;
}

function defaultPersona(store: PersonaStore): PersonaRecord | undefined {
	const records = store.records();
	const name = store.defaultPersonaName();
	return records.find((record) => record.name === name) ?? records[0];
}

/** 会话下拉选项：取不到（未连接 / 扫描失败）不影响表格本身。 */
async function chatOptions(deps: PersonaRpcDeps): Promise<ChatOption[]> {
	if (deps.listChats === undefined) return [];
	try {
		return await deps.listChats();
	} catch (error) {
		deps.logger.warn(`dsh-qq-bot: 枚举会话下拉选项失败: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

interface SoulTarget {
	chat: string;
	key: string;
	dir: string;
}

function soulTarget(deps: PersonaRpcDeps, payload: unknown): SoulTarget | { error: string } {
	const body = asRecord(payload);
	const chat = typeof body.chat === 'string' ? body.chat.trim() : '';
	const selector = parseChatSelector(chat);
	if (selector === null) return { error: 'chat 必须是 friend_QQ号 或 group_群号' };
	return {
		chat,
		key: selector.key,
		dir: sessionDirFor(deps.sessionsRoot, selector.scope, selector.chatId),
	};
}

function listSouls(deps: PersonaRpcDeps): Array<Record<string, unknown>> {
	let entries: Array<{ name: string; isDirectory: () => boolean }>;
	try {
		entries = readdirSync(deps.sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const souls: Array<Record<string, unknown>> = [];
	for (const entry of entries) {
		if (souls.length >= 200) break;
		if (typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
		const match = /^(Friend|Group)_(\d+)$/.exec(entry.name);
		if (match === null) continue;
		const scope = match[1] === 'Friend' ? 'private' : 'group';
		const chatId = match[2]!;
		const key = scope === 'private' ? `u-${chatId}` : `g-${chatId}`;
		const chat = scope === 'private' ? `friend_${chatId}` : `group_${chatId}`;
		const dir = join(deps.sessionsRoot, entry.name);
		const fallback = deps.store.resolve(key).prompt;
		const info = inspectSoul(dir, fallback);
		souls.push({
			chat,
			path: soulPath(dir),
			exists: info.exists,
			source: info.source,
			chars: info.chars,
			preview: info.text.slice(0, 80),
			template: deps.store.resolve(key).name,
		});
	}
	souls.sort((a, b) => String(a.chat).localeCompare(String(b.chat)));
	return souls;
}

/**
 * 处理一个端点；不是本模块的端点返回 undefined。
 * 支持的端点：personas/list | personas/save | personas/default | souls/list |
 * souls/read | souls/save | souls/apply | souls/reset | routes/list | routes/save |
 * models/list。
 */
export async function handlePersonaRpc(
	endpoint: string,
	payload: unknown,
	deps: PersonaRpcDeps,
): Promise<PersonaRpcResult | undefined> {
	try {
		if (endpoint === 'personas/list') {
			return ok({ personas: deps.store.records(), default: deps.store.defaultPersonaName() });
		}
		if (endpoint === 'personas/save') {
			const body = asRecord(payload);
			const parsed = parsePersonaRecords(body.personas);
			if ('error' in parsed) return fail('invalid', parsed.error);
			// WebUI 已无「默认」单选：只有显式传 default 才改默认名，否则保留原默认。
			const defaultName = nonEmptyString(body.default) ?? null;
			deps.store.setLibrary(parsed.records, defaultName);
			await deps.refreshBridges();
			deps.logger.info(`dsh-qq-bot: 人格库已更新（${parsed.records.length} 个人格，库默认 ${deps.store.defaultPersonaName()}）`);
			return ok({ personas: deps.store.records(), default: deps.store.defaultPersonaName() });
		}
		if (endpoint === 'personas/default') {
			const body = asRecord(payload);
			const name = typeof body.name === 'string' ? body.name.trim() : '';
			if (name !== '' && !deps.store.records().some((record) => record.name === name)) return fail('not-found', `没有模板「${name}」`);
			// 只改「新会话默认模板」（chat-overrides 的默认会话行 persona），
			// 同一行的 model / effort 原样保留；不重建会话（只影响以后新建的 SOUL.md）。
			deps.store.setDefaultPersonaSeed(name === '' ? null : name);
			deps.logger.info(`dsh-qq-bot: 新会话默认人格模板 → ${name === '' ? `（人格库默认 ${deps.store.defaultPersonaName()}）` : name}`);
			return ok({ defaultTemplate: deps.store.defaultPersonaSeed() ?? null, libraryDefault: deps.store.defaultPersonaName() });
		}
		if (endpoint === 'routes/list') {
			return ok({
				rows: toRowViews(deps.store.mappings()),
				default: toDefaultView(deps.store.defaultMapping()),
				// 人格留空时的回落值（人格库默认人格），供下拉标签显示。
				libraryDefault: deps.store.defaultPersonaName(),
				// 会话下拉：群 / 好友 + 已有会话目录 + 已保存的号码行（见 chatList.ts）。
				chats: await chatOptions(deps),
			});
		}
		if (endpoint === 'routes/save') {
			const body = asRecord(payload);
			const { rows, invalid } = parseMappingRows(body.rows);
			if (invalid.length > 0) return fail('invalid', `无法识别的会话选择器：${invalid.join('、')}（应为 friend_QQ号 或 group_群号）`);
			deps.store.setMappings(rows);
			// 老客户端不带 default 字段：视为不动「默认会话」行。
			if (body.default !== undefined) deps.store.setDefaultMapping(parseDefaultMapping(body.default));
			await deps.refreshBridges();
			deps.logger.info(`dsh-qq-bot: 会话模型设置已更新（${rows.length} 行 + 默认会话行）`);
			return ok({
				rows: toRowViews(deps.store.mappings()),
				default: toDefaultView(deps.store.defaultMapping()),
				libraryDefault: deps.store.defaultPersonaName(),
				chats: await chatOptions(deps),
			});
		}
		if (endpoint === 'models/list') {
			return ok({ models: await listModelOptions(deps) });
		}
		if (endpoint === 'souls/list') {
			return ok({
				souls: listSouls(deps),
				// 新会话（还没有 SOUL.md）播种用的人格模板：显式设置优先，否则跟随人格库默认。
				defaultTemplate: deps.store.defaultPersonaSeed() ?? null,
				libraryDefault: deps.store.defaultPersonaName(),
			});
		}
		if (endpoint === 'souls/read') {
			const target = soulTarget(deps, payload);
			if ('error' in target) return fail('invalid', target.error);
			const fallback = deps.store.resolve(target.key).prompt;
			const info = inspectSoul(target.dir, fallback);
			return ok({
				chat: target.chat,
				path: soulPath(target.dir),
				content: info.text,
				source: info.source,
				exists: info.exists,
				chars: info.chars,
				error: info.error ?? null,
				template: deps.store.resolve(target.key).name,
			});
		}
		if (endpoint === 'souls/save') {
			const target = soulTarget(deps, payload);
			if ('error' in target) return fail('invalid', target.error);
			const body = asRecord(payload);
			const content = typeof body.content === 'string' ? body.content : '';
			if ([...content].length > MAX_SOUL_CHARS) return fail('invalid', `SOUL.md 不能超过 ${MAX_SOUL_CHARS} 字`);
			const written = writeSoulText(target.dir, content);
			if (!written.ok) return fail('internal', written.error);
			await deps.refreshBridges();
			return ok({ chat: target.chat, path: written.path, content, source: 'file', exists: true, chars: [...content].length });
		}
		if (endpoint === 'souls/reset') {
			const target = soulTarget(deps, payload);
			if ('error' in target) return fail('invalid', target.error);
			const fallback = defaultPersona(deps.store);
			if (fallback === undefined) return fail('invalid', '人格库为空，无法恢复默认');
			const written = writeSoulText(target.dir, fallback.prompt);
			if (!written.ok) return fail('internal', written.error);
			await deps.refreshBridges();
			return ok({ chat: target.chat, path: written.path, content: fallback.prompt, source: 'file', exists: true, chars: [...fallback.prompt].length, template: fallback.name });
		}
		if (endpoint === 'souls/apply') {
			const target = soulTarget(deps, payload);
			if ('error' in target) return fail('invalid', target.error);
			const body = asRecord(payload);
			const name = nonEmptyString(body.persona);
			if (name === undefined) return fail('invalid', '缺少 persona');
			const record = deps.store.records().find((entry) => entry.name === name);
			if (record === undefined) return fail('not-found', `没有模板「${name}」`);
			if ([...record.prompt].length > MAX_SOUL_CHARS) return fail('invalid', `模板「${name}」超过 ${MAX_SOUL_CHARS} 字`);
			const written = writeSoulText(target.dir, record.prompt);
			if (!written.ok) return fail('internal', written.error);
			await deps.refreshBridges();
			return ok({ chat: target.chat, path: written.path, content: record.prompt, source: 'file', exists: true, chars: [...record.prompt].length, template: record.name });
		}
		return undefined;
	} catch (error) {
		deps.logger.warn(`dsh-qq-bot: ${endpoint} 处理失败: ${error instanceof Error ? error.message : String(error)}`);
		return fail('internal', error instanceof Error ? error.message : String(error));
	}
}
