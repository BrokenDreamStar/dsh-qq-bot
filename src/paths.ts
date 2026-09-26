/**
 * 统一路径解析 —— 本插件只有**一个**路径设置：`dataDir`（数据目录）。
 *
 * 数据目录里同时存放（各服务只认这一个根）：
 *   sessions/Friend_<QQ号>|Group_<群号>/   会话目录：agent 默认工作目录 + dsh
 *                                          工作区 + 媒体落盘根（media/<chatKey>）
 *   personas.json / chat-overrides.json    人格库与会话覆盖
 *   chat-sessions.json / workspaces.json   会话身份表与 /cwd 覆盖
 *   tasks.json / roster/                   定时任务与群成员缓存
 *   admins.json / message-log.ndjson       动态管理员与消息日志
 *
 * 默认 = `<用户主目录>/dsh-qq-bot-data`（v0.3 前是 `<dsh 启动目录>/dsh-qq-bot-data`
 * 加会话根 `<dsh 启动目录>/qq-chats` 两个根）。
 *
 * 旧字段仍是**读取兜底**（`dataDir` > `workspaceRoot` > `sessionGroupRoot`）：
 * 老部署没写新键时路径不变（见 config.ts 的废弃说明），由 dataDirMigration
 * 把旧值搬进新键，页面才会显示真实的根。本模块是纯逻辑（只依赖 node:path /
 * node:fs），宿主半专用，不进 client bundle。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

/** 默认数据目录名（`<用户主目录>/dsh-qq-bot-data`）。 */
export const DEFAULT_DATA_DIR_NAME = 'dsh-qq-bot-data';

/** 会话目录的固定子目录名（`<数据目录>/sessions`）。 */
export const SESSIONS_DIR_NAME = 'sessions';

/** 旧版会话数据根名（默认 `join(cwd, 'qq-chats')`；v0.3 起并入数据目录）。 */
export const LEGACY_SESSIONS_DIR_NAME = 'qq-chats';

/**
 * 数据目录里的已知数据条目（迁移时按需复制）。
 * 不含 `sessions/`：会话目录随会话身份走，老会话的工作目录不可改，必须 /reset。
 */
export const KNOWN_DATA_ENTRIES = [
	'personas.json',
	'chat-overrides.json',
	'chat-sessions.json',
	'workspaces.json',
	'tasks.json',
	'admins.json',
	'message-log.ndjson',
	'roster',
] as const;

/** 只读的路径相关配置面（便于测试传最小对象）。 */
export interface PathConfigLike {
	dataDir: string;
	workspaceRoot?: string;
	sessionGroupRoot?: string;
	adminUsersFile?: string;
}

/** 解析路径时的环境（宿主半注入，纯函数便于测试）。 */
export interface PathEnv {
	/** 用户主目录（node:os 的 homedir()）。 */
	homeDir: string;
	/** dsh 启动目录（process.cwd()）：旧版默认目录的基准。 */
	cwd: string;
}

/** 默认数据目录：`<用户主目录>/dsh-qq-bot-data`。 */
export function defaultDataDir(homeDir: string): string {
	return join(homeDir, DEFAULT_DATA_DIR_NAME);
}

/** 旧版默认数据目录：`<dsh 启动目录>/dsh-qq-bot-data`（迁移来源）。 */
export function legacyDefaultDataDir(cwd: string): string {
	return join(cwd, DEFAULT_DATA_DIR_NAME);
}

/** 旧版会话数据根：`workspaceRoot` > `sessionGroupRoot` > `<dsh 启动目录>/qq-chats`。 */
export function legacySessionsRoot(config: PathConfigLike, env: PathEnv): string {
	const explicit = legacyRootOf(config);
	return explicit !== '' ? explicit : join(env.cwd, LEGACY_SESSIONS_DIR_NAME);
}

/** 旧布局里的会话目录名（私聊 `Friend_<QQ号>`、群聊 `Group_<群号>`）。 */
const SESSION_DIR_PATTERN = /^(?:Friend|Group)_\d+$/;

/**
 * 旧会话根里还留着的会话目录名（升级提示用；没有则返回空数组）。
 *
 * 旧布局是 `<旧根>/Friend_*`，现在会话在 `<数据目录>/sessions/`。旧根很可能
 * 就是数据目录本身（v0.3 前的 workspaceRoot 被搬成了 dataDir），所以必须按
 * 目录名判断——只看"目录是否存在"的话，用户把文件移走之后提示也永远消不掉。
 */
export function legacySessionLeftovers(config: PathConfigLike, env: PathEnv): string[] {
	try {
		return readdirSync(legacySessionsRoot(config, env), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && SESSION_DIR_PATTERN.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** 展开开头的 `~`（用户在设置页手填 `~/dsh-qq-bot-data` 时不必知道绝对路径）。 */
export function expandHome(input: string, homeDir: string): string {
	if (input === '~') return homeDir;
	if (input.startsWith(`~${sep}`) || input.startsWith('~/')) return join(homeDir, input.slice(2));
	return input;
}

/** 旧字段里的数据根（`workspaceRoot` > `sessionGroupRoot`，只做 trim；`~` 由调用方展开）。 */
function legacyRootOf(config: PathConfigLike): string {
	return config.workspaceRoot?.trim() || config.sessionGroupRoot?.trim() || '';
}

/**
 * 数据目录解析顺序：`dataDir` > 旧 `workspaceRoot` > 更旧的 `sessionGroupRoot` > 默认。
 *
 * 老部署只设了旧键时**数据目录本身不变**（人格库、身份表、任务等原地保留），
 * 新部署留空即用 `<用户主目录>/dsh-qq-bot-data`。注意会话目录是数据目录下的
 * `sessions/` 子目录（新布局），所以老会话的 `header.cwd` 仍会对不上、需要
 * /reset 一次——见 index.ts 的迁移提示。
 */
export function resolveDataDir(config: PathConfigLike, env: PathEnv): string {
	const unified = config.dataDir.trim();
	if (unified !== '') return expandHome(unified, env.homeDir);
	const legacy = legacyRootOf(config);
	return legacy !== '' ? expandHome(legacy, env.homeDir) : defaultDataDir(env.homeDir);
}

/** 会话目录根：`<数据目录>/sessions`（每个聊天对象一个 Friend_/Group_ 子目录）。 */
export function resolveSessionsRoot(config: PathConfigLike, env: PathEnv): string {
	return join(resolveDataDir(config, env), SESSIONS_DIR_NAME);
}

/**
 * 动态管理员文件：旧字段 `adminUsersFile` 有值时仍以它为准（老部署的 /op 记录
 * 不会丢），否则 `<数据目录>/admins.json`。旧字段已从设置页移除，只需读写兼容。
 */
export function resolveAdminFile(config: PathConfigLike, dataDir: string, homeDir: string): string {
	const explicit = config.adminUsersFile?.trim() ?? '';
	return explicit !== '' ? expandHome(explicit, homeDir) : join(dataDir, 'admins.json');
}

/** 一次性路径迁移计划（见 dataDirMigration）。 */
export interface DataDirMigration {
	/** 写回设置的计划：把旧根搬进 `dataDir`（只 set 不 unset 旧键，回退旧版本仍可用）。 */
	ops: Array<{ op: 'set'; path: string[]; value: string }>;
	/** 需要搬迁的旧数据目录（旧 `dataDir`，未设时 = `<dsh 启动目录>/dsh-qq-bot-data`）。 */
	copyFrom?: string;
	/** 统一后的数据目录（搬迁目标）。 */
	copyTo: string;
}

/** 两个路径是否指向同一处（字符串归一化比较；目录可能都还不存在）。 */
function samePath(a: string, b: string): boolean {
	return resolvePath(a) === resolvePath(b);
}

/**
 * 一次性路径迁移计划：把「旧会话根 / 旧数据目录」合并成统一的 `dataDir`。
 *
 * - 写回：`dataDir` 为空而旧键有值时，把旧根写进 `dataDir`（等价路径，页面
 *   才显示真实的根；旧键保留，回退旧版本仍可用）。
 * - 搬迁：旧数据目录（旧 `dataDir` 或旧默认目录）与统一后的数据目录不同时，
 *   把已知数据文件（人格库、会话身份表、任务、管理员、群成员缓存…）按需复制
 *   过去——**只补缺、不覆盖**，见 migrateLegacyDataFiles。
 *
 * 会话目录不搬迁：`sessions/` 是新布局，老会话的工作目录创建后不可修改，
 * 需 /reset 一次才会落到新目录。
 */
export function dataDirMigration(config: PathConfigLike, env: PathEnv): DataDirMigration {
	const legacyRoot = legacyRootOf(config);
	const resolved = resolveDataDir(config, env);
	const declared = config.dataDir.trim();
	// 旧版实际生效的数据目录：显式 dataDir > 旧默认目录。
	const previous = declared !== '' ? expandHome(declared, env.homeDir) : legacyDefaultDataDir(env.cwd);
	const ops: DataDirMigration['ops'] = [];
	if (declared === '' && legacyRoot !== '') ops.push({ op: 'set', path: ['dataDir'], value: legacyRoot });
	return samePath(previous, resolved) ? { ops, copyTo: resolved } : { ops, copyFrom: previous, copyTo: resolved };
}

/** 数据文件搬迁结果（调用方据此记日志）。 */
export interface DataFileMigrationResult {
	/** 本次真正复制过去的条目名。 */
	copied: string[];
	/** 本次是否执行过搬迁（旧目录存在且此前没搬过）。 */
	ran: boolean;
	errors: Array<{ entry: string; message: string }>;
}

/** 搬迁标记文件：写在新数据目录里，表示"旧目录的内容已搬过，别再往回补"。 */
export const MIGRATION_MARKER = '.legacy-data-migrated';

/**
 * 执行数据文件搬迁：把 `plan.copyFrom` 里的已知数据条目按需复制到 `plan.copyTo`。
 *
 * - **只补缺、不覆盖**：目标已存在同名条目的一律跳过（新目录里的数据更新）。
 * - **一次性**：搬过一次后在目标目录写标记文件，之后不再从旧目录回补——否则用户
 *   在新目录里删掉的条目会被旧目录里的陈旧副本"复活"。
 * - 失败只回报不抛出：绝不能因为一次搬迁失败挡住插件启动。
 */
export function migrateLegacyDataFiles(plan: DataDirMigration): DataFileMigrationResult {
	const result: DataFileMigrationResult = { copied: [], ran: false, errors: [] };
	const from = plan.copyFrom;
	if (from === undefined || samePath(from, plan.copyTo)) return result;
	// 旧目录还不存在（比如换了启动目录）：先不写标记，等它出现时再搬一次。
	if (existsSync(join(plan.copyTo, MIGRATION_MARKER)) || !existsSync(from)) return result;
	try {
		mkdirSync(plan.copyTo, { recursive: true });
	} catch (error) {
		result.errors.push({ entry: plan.copyTo, message: error instanceof Error ? error.message : String(error) });
		return result;
	}
	for (const entry of KNOWN_DATA_ENTRIES) {
		const source = join(from, entry);
		const target = join(plan.copyTo, entry);
		try {
			if (!existsSync(source) || existsSync(target)) continue;
			const isDir = statSync(source).isDirectory();
			if (isDir) cpSync(source, target, { recursive: true, errorOnExist: false, force: false });
			else copyFileSync(source, target);
			result.copied.push(entry);
		} catch (error) {
			result.errors.push({ entry, message: error instanceof Error ? error.message : String(error) });
		}
	}
	result.ran = true;
	try {
		writeFileSync(join(plan.copyTo, MIGRATION_MARKER), `${from}\n`, 'utf8');
	} catch (error) {
		// 标记写不进去只是下次会再扫一遍（已存在的条目会跳过），不必打扰用户。
		result.errors.push({ entry: MIGRATION_MARKER, message: error instanceof Error ? error.message : String(error) });
	}
	return result;
}
