/**
 * 统一路径解析与旧路径迁移（paths.ts）——纯逻辑 + 真实临时目录。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MIGRATION_MARKER,
	dataDirMigration,
	defaultDataDir,
	expandHome,
	legacyDefaultDataDir,
	legacySessionLeftovers,
	legacySessionsRoot,
	migrateLegacyDataFiles,
	resolveAdminFile,
	resolveDataDir,
	resolveSessionsRoot,
} from './paths.ts';

const env = { homeDir: '/Users/u', cwd: '/work/app' };
const temps: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDataDir（唯一的路径设置）', () => {
	it('默认 = <用户主目录>/dsh-qq-bot-data', () => {
		expect(resolveDataDir({ dataDir: '' }, env)).toBe(join('/Users/u', 'dsh-qq-bot-data'));
		expect(resolveDataDir({ dataDir: '   ' }, env)).toBe(defaultDataDir('/Users/u'));
	});

	it('dataDir 优先，并做 trim 与 ~ 展开', () => {
		expect(resolveDataDir({ dataDir: '/data/qq' }, env)).toBe('/data/qq');
		expect(resolveDataDir({ dataDir: '  /data/qq  ' }, env)).toBe('/data/qq');
		expect(resolveDataDir({ dataDir: '~/qq-bot' }, env)).toBe(join('/Users/u', 'qq-bot'));
		expect(resolveDataDir({ dataDir: '~/qq-bot', workspaceRoot: '/old' }, env)).toBe(join('/Users/u', 'qq-bot'));
	});

	it('dataDir 为空时沿用旧 workspaceRoot（老部署路径不变）', () => {
		expect(resolveDataDir({ dataDir: '', workspaceRoot: '/data/qq', sessionGroupRoot: '/older' }, env)).toBe('/data/qq');
		expect(resolveDataDir({ dataDir: '  ', workspaceRoot: '  /data/qq  ' }, env)).toBe('/data/qq');
	});

	it('workspaceRoot 也为空时用更旧的 sessionGroupRoot', () => {
		expect(resolveDataDir({ dataDir: '', workspaceRoot: '', sessionGroupRoot: '/older' }, env)).toBe('/older');
	});

	it('会话目录根 = <数据目录>/sessions', () => {
		expect(resolveSessionsRoot({ dataDir: '/data/qq' }, env)).toBe(join('/data/qq', 'sessions'));
		expect(resolveSessionsRoot({ dataDir: '', workspaceRoot: '/old' }, env)).toBe(join('/old', 'sessions'));
		expect(resolveSessionsRoot({ dataDir: '' }, env)).toBe(join('/Users/u', 'dsh-qq-bot-data', 'sessions'));
	});
});

describe('legacySessionsRoot / expandHome / resolveAdminFile', () => {
	it('旧会话目录：旧根 > 旧默认 <dsh 启动目录>/qq-chats', () => {
		expect(legacySessionsRoot({ dataDir: '', workspaceRoot: '/old' }, env)).toBe('/old');
		expect(legacySessionsRoot({ dataDir: '', sessionGroupRoot: '/older' }, env)).toBe('/older');
		expect(legacySessionsRoot({ dataDir: '/data/qq' }, env)).toBe(join('/work/app', 'qq-chats'));
	});

	it('expandHome 只展开开头的 ~', () => {
		expect(expandHome('~', '/Users/u')).toBe('/Users/u');
		expect(expandHome('~/x', '/Users/u')).toBe(join('/Users/u', 'x'));
		expect(expandHome('/a/~/b', '/Users/u')).toBe('/a/~/b');
		expect(expandHome('~x', '/Users/u')).toBe('~x');
	});

	it('管理员文件：旧 adminUsersFile 有值时沿用（含 ~），否则 <数据目录>/admins.json', () => {
		expect(resolveAdminFile({ dataDir: '/data/qq' }, '/data/qq', '/Users/u')).toBe(join('/data/qq', 'admins.json'));
		expect(resolveAdminFile({ dataDir: '/data/qq', adminUsersFile: '/etc/qq-admins.json' }, '/data/qq', '/Users/u')).toBe('/etc/qq-admins.json');
		expect(resolveAdminFile({ dataDir: '/data/qq', adminUsersFile: '  ' }, '/data/qq', '/Users/u')).toBe(join('/data/qq', 'admins.json'));
		expect(resolveAdminFile({ dataDir: '/data/qq', adminUsersFile: '~/admins.json' }, '/data/qq', '/Users/u')).toBe(join('/Users/u', 'admins.json'));
	});
});

describe('dataDirMigration（写回 + 搬迁来源）', () => {
	it('dataDir 为空、旧根有值：写回 dataDir（只 set 不 unset 旧键）', () => {
		const plan = dataDirMigration({ dataDir: '', workspaceRoot: '/old', sessionGroupRoot: '/older' }, env);
		expect(plan.ops).toEqual([{ op: 'set', path: ['dataDir'], value: '/old' }]);
		expect(plan.copyTo).toBe('/old');
		// 旧数据目录 = 旧默认目录（未显式设过 dataDir）。
		expect(plan.copyFrom).toBe(join('/work/app', 'dsh-qq-bot-data'));
	});

	it('dataDir 已有值：不写回，也不从旧目录补数据', () => {
		const plan = dataDirMigration({ dataDir: '/data/qq', workspaceRoot: '/old' }, env);
		expect(plan.ops).toEqual([]);
		expect(plan.copyFrom).toBeUndefined();
	});

	it('dataDir 为空且无旧键：目标是新默认目录，来源是旧默认目录（cwd 与主目录不同才搬）', () => {
		const plan = dataDirMigration({ dataDir: '' }, env);
		expect(plan.ops).toEqual([]);
		expect(plan.copyTo).toBe(join('/Users/u', 'dsh-qq-bot-data'));
		expect(plan.copyFrom).toBe(join('/work/app', 'dsh-qq-bot-data'));
	});

	it('cwd 就是主目录时新旧默认目录同一处：无需搬迁', () => {
		const plan = dataDirMigration({ dataDir: '' }, { homeDir: '/Users/u', cwd: '/Users/u' });
		expect(plan.copyTo).toBe(defaultDataDir('/Users/u'));
		expect(plan.copyFrom).toBeUndefined();
	});
});

describe('migrateLegacyDataFiles（只补缺、不覆盖、一次性）', () => {
	it('把已知数据条目复制到新数据目录，且不碰已有条目', () => {
		const from = tempDir('dshqq-old-');
		const to = tempDir('dshqq-new-');
		writeFileSync(join(from, 'personas.json'), '{"a":1}', 'utf8');
		writeFileSync(join(from, 'chat-sessions.json'), '{"u-1":"s1"}', 'utf8');
		writeFileSync(join(from, 'message-log.ndjson'), 'x\n', 'utf8');
		mkdirSync(join(from, 'roster'), { recursive: true });
		writeFileSync(join(from, 'roster', 'g-1.json'), '[]', 'utf8');
		// 目标已有更新的同名文件：必须保留目标内容。
		writeFileSync(join(to, 'personas.json'), '{"a":2}', 'utf8');

		const result = migrateLegacyDataFiles({ ops: [], copyFrom: from, copyTo: to });
		expect(result.ran).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.copied.sort()).toEqual(['chat-sessions.json', 'message-log.ndjson', 'roster']);
		expect(readFileSync(join(to, 'personas.json'), 'utf8')).toBe('{"a":2}');
		expect(readFileSync(join(to, 'chat-sessions.json'), 'utf8')).toBe('{"u-1":"s1"}');
		expect(existsSync(join(to, 'roster', 'g-1.json'))).toBe(true);
		// 旧目录保留（可回退），只在新目录留标记。
		expect(existsSync(join(from, 'personas.json'))).toBe(true);
		expect(readFileSync(join(to, MIGRATION_MARKER), 'utf8').trim()).toBe(from);
	});

	it('搬过一次后不再回补：新目录里删掉的条目不会被旧副本复活', () => {
		const from = tempDir('dshqq-old-');
		const to = tempDir('dshqq-new-');
		writeFileSync(join(from, 'personas.json'), '{}', 'utf8');
		expect(migrateLegacyDataFiles({ ops: [], copyFrom: from, copyTo: to }).ran).toBe(true);
		rmSync(join(to, 'personas.json'));
		const second = migrateLegacyDataFiles({ ops: [], copyFrom: from, copyTo: to });
		expect(second.ran).toBe(false);
		expect(second.copied).toEqual([]);
		expect(existsSync(join(to, 'personas.json'))).toBe(false);
	});

	it('旧目录还不存在时不写标记（换个启动目录后仍能搬一次）', () => {
		const to = tempDir('dshqq-new-');
		const missing = join(tempDir('dshqq-none-'), 'dsh-qq-bot-data');
		const result = migrateLegacyDataFiles({ ops: [], copyFrom: missing, copyTo: to });
		expect(result.ran).toBe(false);
		expect(existsSync(join(to, MIGRATION_MARKER))).toBe(false);
	});

	it('来源与目标同一处时什么都不做', () => {
		const dir = tempDir('dshqq-same-');
		writeFileSync(join(dir, 'personas.json'), '{}', 'utf8');
		const result = migrateLegacyDataFiles({ ops: [], copyFrom: dir, copyTo: dir });
		expect(result.ran).toBe(false);
		expect(existsSync(join(dir, MIGRATION_MARKER))).toBe(false);
	});

	it('legacyDefaultDataDir 指向 <cwd>/dsh-qq-bot-data', () => {
		expect(legacyDefaultDataDir('/work/app')).toBe(join('/work/app', 'dsh-qq-bot-data'));
	});
});

describe('legacySessionLeftovers（旧布局会话目录提示）', () => {
	it('只认出旧布局的 Friend_/Group_ 目录，新布局与数据文件不算', () => {
		const root = tempDir('dshqq-legacy-');
		mkdirSync(join(root, 'Friend_12345'));
		mkdirSync(join(root, 'Group_67890'));
		mkdirSync(join(root, 'sessions'));
		writeFileSync(join(root, 'personas.json'), '{}', 'utf8');
		// 写完 dataDir 后旧键仍在（只 set 不 unset），所以旧会话根 = 旧键的值。
		expect(legacySessionLeftovers({ dataDir: root, workspaceRoot: root }, env)).toEqual(['Friend_12345', 'Group_67890']);
	});

	it('搬走之后提示自动消失（旧根就是数据目录本身时也不能永远报）', () => {
		const root = tempDir('dshqq-legacy-');
		mkdirSync(join(root, 'sessions', 'Friend_12345'), { recursive: true });
		expect(legacySessionLeftovers({ dataDir: root, workspaceRoot: root }, env)).toEqual([]);
	});

	it('没有旧键时看 <dsh 启动目录>/qq-chats，不存在则空数组', () => {
		expect(legacySessionLeftovers({ dataDir: '' }, env)).toEqual([]);
	});
});

describe('真实升级场景（老配置：只设了 workspaceRoot）', () => {
	const realEnv = { homeDir: '/Users/u', cwd: '/Users/u' };
	const legacyConfig = { dataDir: '', workspaceRoot: '/Users/u/dsh_data', sessionGroupRoot: '/Users/u/dsh_data' };

	it('数据目录 = 旧根、会话目录 = 旧根/sessions、旧默认数据目录待搬迁', () => {
		expect(resolveDataDir(legacyConfig, realEnv)).toBe('/Users/u/dsh_data');
		expect(resolveSessionsRoot(legacyConfig, realEnv)).toBe(join('/Users/u/dsh_data', 'sessions'));
		const plan = dataDirMigration(legacyConfig, realEnv);
		// 写回 dataDir，页面才显示真实的数据目录；旧键保留（回退旧版本仍可用）。
		expect(plan.ops).toEqual([{ op: 'set', path: ['dataDir'], value: '/Users/u/dsh_data' }]);
		// 老部署的数据文件（人格库、会话身份表…）在 cwd 的默认目录里，需搬到新数据目录。
		expect(plan.copyFrom).toBe(join('/Users/u', 'dsh-qq-bot-data'));
		expect(plan.copyTo).toBe('/Users/u/dsh_data');
	});

	it('写回后再启动：不再搬迁，会话身份表按新数据目录读', () => {
		const migrated = { ...legacyConfig, dataDir: '/Users/u/dsh_data' };
		expect(dataDirMigration(migrated, realEnv).ops).toEqual([]);
		expect(dataDirMigration(migrated, realEnv).copyFrom).toBeUndefined();
		expect(resolveAdminFile(migrated, resolveDataDir(migrated, realEnv), realEnv.homeDir)).toBe(
			join('/Users/u/dsh_data', 'admins.json'),
		);
	});
});
