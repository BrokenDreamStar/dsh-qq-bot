import { describe, expect, it } from 'vitest';
import {
	DshQQCardController,
	FIELD_GROUPS,
	formatField,
	getPath,
	hasPath,
	joinModelSpec,
	parseField,
	SETTINGS_NS,
	splitModelSpec,
} from './form.ts';
import { en, zh } from './locales.ts';
import { addOrderItem, moveOrderItem, removeOrderItem } from '../search/priority.ts';
import type { CardState, SettingsPathOp, SettingsScope, SettingsScopeSnapshot, SnapshotStore } from './types.ts';

/** inject 面的确切形状（form.ts 的 DshQQCardController.inject 产物）。 */
interface CardFace {
	hooks: { dshQQCard: SnapshotStore<CardState> };
	edit: (key: string, text: string) => void;
	stageValue: (key: string, value: unknown) => void;
	stageList: (key: string, items: string[]) => void;
	stageClear: (key: string) => void;
	resetField: (key: string) => void;
	save: (cardId: string) => void;
	discard: (cardId: string) => void;
}

describe('字段定义与文案字典', () => {
	it('每个分组都有 id/分区/标题/描述，每个字段都有 zh/en 的 Label 与 Hint', () => {
		for (const group of FIELD_GROUPS) {
			expect(group.id, 'group id').toBeTruthy();
			expect(group.sectionKey, `group ${group.id} sectionKey`).toBeTruthy();
			expect(zh[group.titleKey], `group ${group.titleKey}`).toBeTruthy();
			expect(en[group.titleKey], `group ${group.titleKey} (en)`).toBeTruthy();
			expect(zh[group.descKey], `group ${group.descKey}`).toBeTruthy();
			expect(en[group.descKey], `group ${group.descKey} (en)`).toBeTruthy();
			for (const def of group.fields) {
				expect(zh[`${def.key}Label`], `${def.key}Label (zh)`).toBeTruthy();
				expect(zh[`${def.key}Hint`], `${def.key}Hint (zh)`).toBeTruthy();
				expect(en[`${def.key}Label`], `${def.key}Label (en)`).toBeTruthy();
				expect(en[`${def.key}Hint`], `${def.key}Hint (en)`).toBeTruthy();
			}
		}
	});

	it('enum 与 orderList 的每个取值都有 zh/en 选项文案', () => {
		for (const group of FIELD_GROUPS) {
			for (const def of group.fields) {
				// orderList 的选项同样是 ${key}.${value}（列表行与"加入"按钮都用它）。
				if ((def.kind !== 'enum' && def.kind !== 'orderList') || def.options === undefined) continue;
				for (const option of def.options) {
					expect(zh[`${def.key}.${option}`], `${def.key}.${option} (zh)`).toBeTruthy();
					expect(en[`${def.key}.${option}`], `${def.key}.${option} (en)`).toBeTruthy();
				}
			}
		}
	});

	it('配置项全覆盖（含 workspaceMode）：interface 键都出现在某分组里，且分组 id 唯一', () => {
		const all = FIELD_GROUPS.flatMap((group) => group.fields.map((def) => def.key));
		const known = new Set(all);
		const expected = [
			'transport', 'url', 'reversePort', 'reversePath', 'accessToken', 'reconnectDelayMs', 'httpTimeoutMs',
			'privateMode', 'groupMode', 'allowedUsers', 'allowedGroups', 'blockedUsers', 'blockedGroups',
			'adminUsers', 'groupMentionOnly', 'wakePrefixes', 'privateNeedsWake', 'messageFilter', 'groupSession',
			'rateLimit.windowMs', 'rateLimit.max', 'rosterEnabled', 'rosterTtlMs', 'rosterMaxMembers', 'quoteMaxChars',
			'historyEnabled', 'historyMaxMessages', 'historyBufferPerChat', 'historyRemoteFetch',
			'askUserEnabled', 'askUserWaitMs',
			'memoryEnabled', 'memoryCardMaxChars', 'memoryMaxFacts', 'memoryMaxWriteFailuresPerTurn',
			'memoryRecallEnabled', 'memoryRecallTopK', 'memoryRecallMaxChars', 'memoryRecallHalfLifeDays',
			'memoryPrefetch', 'memoryPrefetchMinScore', 'memoryPrefetchMaxItems',
			'memoryDistillEvery', 'memoryDistillMinChars', 'memoryDistillIdleMs',
			'memoryDistillModel', 'memoryDistillMaxTokens', 'memoryDistillTimeoutMs',
			'memoryHandoffTail', 'memoryHandoffDistillWaitMs', 'memoryRetentionDays', 'memoryMaxEventsPerChat',
			'restrictTools', 'userTools', 'blockedTools', 'replyMaxChars',
			'foldForward', 'foldThreshold', 'replyWithQuote', 'replyQuoteOnMention', 'replyWithMention', 'mediaEnabled', 'mediaMaxMB',
			'pokeReply', 'autoApproveRequests', 'preset', 'workspaceMode',
			'dataDir', 'maxTurnMs', 'sessionIdleTimeoutMs', 'busyStrategy', 'busyWaitMs', 'maxQueue', 'registerSendTools',
			'tasksEnabled', 'taskMaxPerChat', 'timeAware',
			'searchEnabled', 'searchOrder', 'exaApiKey', 'exaBaseUrl', 'tavilyApiKey', 'tavilyBaseUrl',
			'searchMaxResults', 'searchMaxQueries', 'searchTimeoutMs',
			'messageLog', 'messageLogMax', 'messageLogToFile', 'debug',
		];
		for (const key of expected) expect(known.has(key), key).toBe(true);
		// 反向也要成立：没有"字典里有、config 里没有"的野生字段。
		expect([...known].sort()).toEqual([...expected].sort());
		expect(new Set(FIELD_GROUPS.map((group) => group.id)).size).toBe(FIELD_GROUPS.length);
	});

	it('settings 命名空间稳定', () => {
		expect(SETTINGS_NS).toBe('dsh-qq-bot');
	});

	it('顶层分区：每张卡都有分区，同一分区必须连续，文案齐全', () => {
		const keys = FIELD_GROUPS.map((group) => group.sectionKey);
		expect(keys.every((key): key is string => typeof key === 'string' && key !== '')).toBe(true);
		const seen = new Set<string>();
		let prev: string | undefined;
		for (const key of keys) {
			if (key === prev) continue;
			// 分区不连续 = 页面会出现两个同名分区标题。
			expect(seen.has(key!), `section ${key} 不连续`).toBe(false);
			seen.add(key!);
			prev = key;
		}
		expect([...seen]).toEqual(['sectionAccess', 'sectionChat', 'sectionRuntime']);
		for (const key of seen) {
			expect(zh[key], key).toBeTruthy();
			expect(en[key], `${key} (en)`).toBeTruthy();
		}
	});

	it('卡内子分节：标签文案齐全且连续，同一标签不在一张卡里出现两次', () => {
		for (const group of FIELD_GROUPS) {
			const subs = group.fields.map((def) => def.sub);
			for (const sub of new Set(subs)) {
				if (sub === undefined) continue;
				expect(zh[sub], `${sub} (zh)`).toBeTruthy();
				expect(en[sub], `${sub} (en)`).toBeTruthy();
			}
			// 渲染器只在标签变化处插一次小标题，不连续的重复标签会渲染两次。
			const runs = subs.filter((sub, index) => index === 0 || sub !== subs[index - 1]);
			expect(new Set(runs).size, `${group.id} 的子分节标签不连续`).toBe(runs.length);
		}
	});

	it('一张卡 = 一个功能域：私聊/群聊的差异是卡内子分节，不再各占一张卡', () => {
		expect(FIELD_GROUPS.map((group) => group.id)).toEqual([
			'connection', 'access', 'tools', 'search',
			'wake', 'session', 'reply', 'roster', 'history', 'ask', 'memory', 'media', 'tasks', 'personas', 'routes',
			'logging', 'agent',
		]);
		// 曾经的「私聊配置」「群聊配置」两张卡已消失。
		expect(FIELD_GROUPS.some((group) => group.id === 'privateChat' || group.id === 'groupChat')).toBe(false);

		// 准入与名单同卡：私聊/群聊是卡内两个作用域分节，黑名单与管理员是
		// 同一套判定的名单分节（历史设计另占一张「黑名单与管理员」卡）。
		expect(FIELD_GROUPS.some((group) => group.id === 'admin')).toBe(false);
		const access = FIELD_GROUPS.find((group) => group.id === 'access');
		expect(access?.fields.map((def) => def.key)).toEqual([
			'privateMode', 'allowedUsers', 'groupMode', 'allowedGroups',
			'blockedUsers', 'blockedGroups', 'adminUsers', 'autoApproveRequests',
		]);
		expect(access?.fields.map((def) => def.sub)).toEqual([
			'subPrivate', 'subPrivate', 'subGroup', 'subGroup',
			'subBlockedAdmins', 'subBlockedAdmins', 'subBlockedAdmins', 'subRequests',
		]);

		// 同一功能域的项不再跨卡：唤醒、回复形态、会话、工具都各自在一张卡里。
		const cardOf = (key: string): string | undefined =>
			FIELD_GROUPS.find((group) => group.fields.some((def) => def.key === key))?.id;
		const subOf = (key: string): string | undefined =>
			FIELD_GROUPS.flatMap((group) => group.fields).find((def) => def.key === key)?.sub;
		expect(cardOf('groupMentionOnly')).toBe(cardOf('wakePrefixes'));
		expect(cardOf('privateNeedsWake')).toBe(cardOf('wakePrefixes'));
		expect(cardOf('replyWithQuote')).toBe(cardOf('replyWithMention'));
		expect(cardOf('quoteMaxChars')).toBe(cardOf('replyWithQuote'));
		// 「被 @ 时引用原消息」与「一律引用」同属引用功能域，同一张卡同一子分节。
		expect(cardOf('replyQuoteOnMention')).toBe(cardOf('replyWithQuote'));
		expect(subOf('replyQuoteOnMention')).toBe(subOf('replyWithQuote'));
		expect(cardOf('groupSession')).toBe(cardOf('sessionIdleTimeoutMs'));
		expect(cardOf('registerSendTools')).toBe(cardOf('restrictTools'));
		// 名单三项与准入模式同卡（保存/放弃以卡为单位，名单不该另存一张）。
		expect(cardOf('blockedUsers')).toBe('access');
		expect(cardOf('blockedGroups')).toBe('access');
		expect(cardOf('adminUsers')).toBe('access');
		expect(cardOf('autoApproveRequests')).toBe('access');

		// 每个字段只归一张卡片：保存/放弃以卡片为单位，重复会让写入归属含混。
		const all = FIELD_GROUPS.flatMap((group) => group.fields.map((def) => def.key));
		expect(new Set(all).size).toBe(all.length);
	});

	it('只读日志视图挂在唯一一个分组上（logging），与日志开关和调试开关同卡', () => {
		const hosts = FIELD_GROUPS.filter((group) => group.logViewer === true);
		expect(hosts.map((group) => group.id)).toEqual(['logging']);
		expect(hosts[0]?.fields.map((def) => def.key)).toEqual(['messageLog', 'messageLogMax', 'messageLogToFile', 'debug']);
	});

	it('人格库、人格与模型、定时任务是三张自定义卡片，位于 Agent 之前且没有 schema 字段', () => {
		const custom = FIELD_GROUPS.filter((group) => group.custom !== undefined);
		expect(custom.map((group) => group.id)).toEqual(['tasks', 'personas', 'routes']);
		expect(custom.map((group) => group.custom)).toEqual(['tasks', 'personas', 'routes']);
		expect(custom.every((group) => group.fields.length === 0)).toBe(true);
		expect(FIELD_GROUPS.map((group) => group.id).indexOf('routes')).toBeLessThan(FIELD_GROUPS.map((group) => group.id).indexOf('agent'));
		// Agent 卡片：workspaceMode 此前没有渲染入口，现已补回；dataDir 是**唯一**
		// 的路径设置（会话目录 + 数据文件都在它下面），所以与工作目录模式同分节。
		// 旧键 workspaceRoot / sessionGroupRoot / adminUsersFile 仅作迁移兜底，不再出现在页面上。
		const agent = FIELD_GROUPS.find((group) => group.id === 'agent');
		expect(agent?.fields.map((def) => def.key)).toEqual(['preset', 'timeAware', 'workspaceMode', 'dataDir']);
		expect(agent?.fields.map((def) => def.sub)).toEqual(['subPreset', 'subTime', 'subWorkspace', 'subWorkspace']);
		// 新卡片文案齐全。
		for (const key of ['groupPersonas', 'groupPersonasDesc', 'groupRoutes', 'groupRoutesDesc', 'groupTasks', 'groupTasksDesc']) {
			expect(zh[key], key).toBeTruthy();
			expect(en[key], `${key} (en)`).toBeTruthy();
		}
	});
});

describe('formatField / parseField', () => {
	it('number：空串 = clear，非数字 = invalid', () => {
		const def = { key: 'replyMaxChars', path: ['replyMaxChars'], kind: 'number' as const };
		expect(formatField(def, 4500)).toBe('4500');
		expect(formatField(def, undefined)).toBe('');
		expect(parseField(def, '')).toEqual({ kind: 'clear' });
		expect(parseField(def, '3000')).toEqual({ kind: 'set', value: 3000 });
		expect(parseField(def, 'abc')).toBeUndefined();
	});

	it('list：逐行拆分、去空行；空 = clear', () => {
		const def = { key: 'allowedUsers', path: ['allowedUsers'], kind: 'list' as const };
		expect(formatField(def, ['123', '456'])).toBe('123\n456');
		expect(parseField(def, ' 123 \n\n 456 ')).toEqual({ kind: 'set', value: ['123', '456'] });
		expect(parseField(def, '')).toEqual({ kind: 'clear' });
	});

	it('lineList：单行控件，逗号（含全角）与换行都算分隔符；空 = clear', () => {
		const def = { key: 'messageFilter', path: ['messageFilter'], kind: 'lineList' as const };
		expect(formatField(def, ['#', '//'])).toBe('#\n//');
		expect(parseField(def, '#')).toEqual({ kind: 'set', value: ['#'] });
		expect(parseField(def, '# , //')).toEqual({ kind: 'set', value: ['#', '//'] });
		expect(parseField(def, '#，//')).toEqual({ kind: 'set', value: ['#', '//'] });
		expect(parseField(def, '#\n//')).toEqual({ kind: 'set', value: ['#', '//'] });
		expect(parseField(def, '   ')).toEqual({ kind: 'clear' });
	});

	it('唤醒前缀与信息过滤都是单行列表（lineList），同类白名单仍是多行 list', () => {
		const card = FIELD_GROUPS.find((group) => group.id === 'wake');
		const kindOf = (key: string): string | undefined => card?.fields.find((def) => def.key === key)?.kind;
		expect(kindOf('wakePrefixes')).toBe('lineList');
		expect(kindOf('messageFilter')).toBe('lineList');
		const access = FIELD_GROUPS.find((group) => group.id === 'access');
		expect(access?.fields.find((def) => def.key === 'allowedUsers')?.kind).toBe('list');
	});

	it('string：trim 后空 = clear', () => {
		const def = { key: 'url', path: ['url'], kind: 'string' as const };
		expect(parseField(def, '  ws://x  ')).toEqual({ kind: 'set', value: 'ws://x' });
		expect(parseField(def, '   ')).toEqual({ kind: 'clear' });
	});

	it('enum：只接受可选取值', () => {
		const def = { key: 'transport', path: ['transport'], kind: 'enum' as const, options: ['forward', 'reverse'] };
		expect(parseField(def, 'reverse')).toEqual({ kind: 'set', value: 'reverse' });
		expect(parseField(def, 'bogus')).toBeUndefined();
	});

	it('secret 永不回显', () => {
		const def = { key: 'accessToken', path: ['accessToken'], kind: 'secret' as const };
		expect(formatField(def, 'top-secret')).toBe('');
	});

	it('modelSelect：字段定义带 provider 伴生路径（一次选择写两项）', () => {
		const def = FIELD_GROUPS.flatMap((group) => group.fields).find((entry) => entry.key === 'memoryDistillModel');
		expect(def?.kind).toBe('modelSelect');
		expect(def?.path).toEqual(['memoryDistillModel']);
		expect(def?.extraPaths).toEqual([['memoryDistillProvider']]);
		// provider 不再单独占一行（值由同一个下拉写入）。
		expect(FIELD_GROUPS.flatMap((group) => group.fields).some((entry) => entry.key === 'memoryDistillProvider')).toBe(false);
	});
});

describe('modelSelect 规格串解析', () => {
	it('splitModelSpec：只按第一个斜杠切分 provider（模型 id 可含斜杠）', () => {
		expect(splitModelSpec('deepseek-official/deepseek-chat')).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' });
		expect(splitModelSpec('openrouter/anthropic/claude-sonnet-4')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
		expect(splitModelSpec('  deepseek-official/deepseek-chat  ')).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' });
	});

	it('splitModelSpec：缺段/空串一律算"未指定"', () => {
		expect(splitModelSpec('')).toEqual({ provider: '', model: '' });
		expect(splitModelSpec('   ')).toEqual({ provider: '', model: '' });
		expect(splitModelSpec('deepseek-official')).toEqual({ provider: '', model: '' });
		expect(splitModelSpec('/deepseek-chat')).toEqual({ provider: '', model: '' });
		expect(splitModelSpec('deepseek-official/')).toEqual({ provider: '', model: '' });
	});

	it('joinModelSpec：任一段为空都返回空串（= 部署默认）', () => {
		expect(joinModelSpec('deepseek-official', 'deepseek-chat')).toBe('deepseek-official/deepseek-chat');
		expect(joinModelSpec('', 'deepseek-chat')).toBe('');
		expect(joinModelSpec('deepseek-official', '')).toBe('');
		expect(joinModelSpec('', '')).toBe('');
	});
});

describe('getPath / hasPath', () => {
	it('支持嵌套路径与存在性判断', () => {
		const obj = { rateLimit: { max: 30 } };
		expect(getPath(obj, ['rateLimit', 'max'])).toBe(30);
		expect(hasPath(obj, ['rateLimit', 'max'])).toBe(true);
		expect(hasPath(obj, ['rateLimit', 'windowMs'])).toBe(false);
		expect(hasPath(undefined, ['a'])).toBe(false);
	});
});

/** 假 settings scope：模拟宿主 resolve + user 层合并，捕获 mutate 调用。 */
function fakeScope(initial: { value?: Record<string, unknown>; user?: Record<string, unknown>; writable?: boolean }) {
	let snapshot: SettingsScopeSnapshot<Record<string, unknown>> = {
		status: 'ready',
		value: initial.value,
		base: {},
		user: initial.user,
		revision: 1,
		writable: initial.writable ?? true,
		mode: 'host',
	};
	const listeners = new Set<() => void>();
	const committed: SettingsPathOp[][] = [];
	const resolve = (userLayer: Record<string, unknown> | undefined): Record<string, unknown> => ({
		...(initial.value ?? {}),
		...(userLayer ?? {}),
	});
	const scope: SettingsScope<Record<string, unknown>> = {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		mutate: async (ops) => {
			committed.push([...ops]);
			const user = { ...(snapshot.user as Record<string, unknown> ?? {}) };
			for (const op of ops) {
				if (op.path.length !== 1) throw new Error('test scope only supports single-segment paths');
				const [field] = op.path;
				if (op.op === 'set') user[field!] = op.value;
				else delete user[field!];
			}
			// 注意先算 value 再替换 snapshot：resolve 必须合并本次写入后的 user 层。
			snapshot = { ...snapshot, user, value: resolve(user), revision: snapshot.revision! + 1 };
			for (const listener of listeners) listener();
		},
		set: async (field, value) => {
			await scope.mutate([{ op: 'set', path: [field], value }]);
		},
		unset: async (field) => {
			await scope.mutate([{ op: 'unset', path: [field] }]);
		},
	};
	return {
		scope,
		committed,
		setWritable(writable: boolean) {
			snapshot = { ...snapshot, writable };
			for (const listener of listeners) listener();
		},
	};
}

async function settle(times = 3): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('DshQQCardController（按卡暂存/保存）', () => {
	it('未暂存时显示 section 值与覆盖状态，各卡均不脏', () => {
		const fake = fakeScope({ value: { transport: 'forward', replyMaxChars: 4500 }, user: { replyMaxChars: 4500 } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.available).toBe(true);
		expect(state.writable).toBe(true);
		expect(state.fields.transport).toMatchObject({ text: 'forward', overridden: false });
		expect(state.fields.replyMaxChars).toMatchObject({ text: '4500', overridden: true });
		expect(Object.values(state.cards).every((card) => !card.dirty)).toBe(true);
	});

	it('卡内编辑 → 保存：原子 mutate、覆盖标记、暂存清空', async () => {
		const fake = fakeScope({ value: { url: 'ws://a', replyMaxChars: 4500 } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('url', 'ws://b');
		let state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.connection.dirty).toBe(true);
		expect(state.cards.connection.invalid).toBe(false);
		expect(state.fields.url.overridden).toBe(true);
		face.save('connection');
		await settle();
		expect(fake.committed).toHaveLength(1);
		expect(fake.committed[0]).toEqual([{ op: 'set', path: ['url'], value: 'ws://b' }]);
		state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.connection.dirty).toBe(false);
		expect(state.cards.connection.failed).toBe(false);
	});

	it('各卡暂存互相隔离：保存一张卡不写出另一卡的草稿', async () => {
		const fake = fakeScope({ value: { url: 'ws://a', replyMaxChars: 4500 } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('url', 'ws://b');
		face.edit('replyMaxChars', '3000');
		face.save('connection');
		await settle();
		expect(fake.committed).toHaveLength(1);
		expect(fake.committed[0]).toEqual([{ op: 'set', path: ['url'], value: 'ws://b' }]);
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.reply.dirty).toBe(true);
		expect(state.fields.replyMaxChars.text).toBe('3000');
		face.save('reply');
		await settle();
		expect(fake.committed[1]).toEqual([{ op: 'set', path: ['replyMaxChars'], value: 3000 }]);
	});

	it('非法数字草稿标记所在卡 invalid 且阻止保存', async () => {
		const fake = fakeScope({ value: { replyMaxChars: 4500 } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('replyMaxChars', 'abc');
		let state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.reply.invalid).toBe(true);
		face.save('reply');
		await settle();
		expect(fake.committed).toHaveLength(0);
		state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.replyMaxChars.invalid).toBe(true);
	});

	it('resetField 走 unset（恢复组合层默认），且随所在卡保存', async () => {
		const fake = fakeScope({ value: { replyMaxChars: 3000, url: 'ws://a' }, user: { replyMaxChars: 3000 } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		expect(face.hooks.dshQQCard.getSnapshot().fields.replyMaxChars.overridden).toBe(true);
		face.resetField('replyMaxChars');
		face.edit('url', 'ws://b');
		face.save('reply');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'unset', path: ['replyMaxChars'] }]);
	});

	it('boolean 开关暂存后随卡保存写入布尔值', async () => {
		const fake = fakeScope({ value: { debug: false } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageValue('debug', true);
		expect(face.hooks.dshQQCard.getSnapshot().fields.debug.checked).toBe(true);
		face.save('logging');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'set', path: ['debug'], value: true }]);
	});

	it('secret：留空不产生写入；写值无法读回验证但不阻塞', async () => {
		const fake = fakeScope({ value: {} });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('accessToken', '   ');
		expect(face.hooks.dshQQCard.getSnapshot().cards.connection.dirty).toBe(false);
		face.edit('accessToken', '  tok ');
		face.save('connection');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'set', path: ['accessToken'], value: 'tok' }]);
		expect(face.hooks.dshQQCard.getSnapshot().cards.connection.failed).toBe(false);
	});

	it('orderList：未暂存时显示当前顺序，选项来自字段定义', () => {
		const fake = fakeScope({ value: { searchOrder: ['tavily', 'dsh'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.searchOrder.kind).toBe('orderList');
		expect(state.fields.searchOrder.values).toEqual(['tavily', 'dsh']);
		expect(state.fields.searchOrder.options).toEqual(['exa', 'tavily', 'dsh']);
		expect(state.cards.search.dirty).toBe(false);
	});

	it('orderList：排序/移出/加入都暂存，保存写入有序数组', async () => {
		const fake = fakeScope({ value: { searchOrder: ['exa', 'tavily', 'dsh'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		// 模拟控件：把第 3 项上移一位，再移出第 1 项。
		face.stageList('searchOrder', moveOrderItem(['exa', 'tavily', 'dsh'], 2, -1));
		let state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.searchOrder.values).toEqual(['exa', 'dsh', 'tavily']);
		expect(state.cards.search.dirty).toBe(true);
		face.stageList('searchOrder', removeOrderItem(['exa', 'dsh', 'tavily'], 'exa'));
		state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.searchOrder.values).toEqual(['dsh', 'tavily']);
		face.stageList('searchOrder', addOrderItem(['dsh', 'tavily'], 'exa'));
		face.save('search');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'set', path: ['searchOrder'], value: ['dsh', 'tavily', 'exa'] }]);
	});

	it('orderList：空列表 = unset（回到组合层默认顺序）', async () => {
		const fake = fakeScope({ value: { searchOrder: ['exa'] }, user: { searchOrder: ['exa'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageList('searchOrder', []);
		expect(face.hooks.dshQQCard.getSnapshot().cards.search.dirty).toBe(true);
		face.save('search');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'unset', path: ['searchOrder'] }]);
	});

	it('toolList：未暂存时显示当前条目与动态选项', () => {
		const fake = fakeScope({ value: { userTools: ['web_search', 'read*'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.userTools.kind).toBe('toolList');
		expect(state.fields.userTools.values).toEqual(['web_search', 'read*']);
		expect(state.fields.userTools.overridden).toBe(false);
		expect(state.cards.tools.dirty).toBe(false);
	});

	it('toolList：勾选暂存 → 保存写入数组', async () => {
		const fake = fakeScope({ value: { userTools: ['web_search'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageList('userTools', ['bash', 'web_search']);
		let state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.tools.dirty).toBe(true);
		expect(state.fields.userTools.values).toEqual(['bash', 'web_search']);
		expect(state.fields.userTools.overridden).toBe(true);
		face.save('tools');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'set', path: ['userTools'], value: ['bash', 'web_search'] }]);
		state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.tools.dirty).toBe(false);
		expect(state.fields.userTools.values).toEqual(['bash', 'web_search']);
	});

	it('toolList：草稿与当前值相同 → 不产生写入', async () => {
		const fake = fakeScope({ value: { userTools: ['web_search'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageList('userTools', ['web_search']);
		expect(face.hooks.dshQQCard.getSnapshot().cards.tools.dirty).toBe(false);
		face.save('tools');
		await settle();
		expect(fake.committed).toHaveLength(0);
	});

	it('toolList：全不勾 = 恢复组合层；无覆盖时不产生写入', async () => {
		const fake = fakeScope({ value: { userTools: ['web_search'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageList('userTools', []);
		expect(face.hooks.dshQQCard.getSnapshot().cards.tools.dirty).toBe(false);
		face.save('tools');
		await settle();
		expect(fake.committed).toHaveLength(0);

		const covered = fakeScope({ value: { userTools: ['web_search'] }, user: { userTools: ['web_search'] } });
		const face2 = new DshQQCardController(covered.scope).inject() as unknown as CardFace;
		face2.stageList('userTools', []);
		expect(face2.hooks.dshQQCard.getSnapshot().cards.tools.dirty).toBe(true);
		face2.save('tools');
		await settle();
		expect(covered.committed[0]).toEqual([{ op: 'unset', path: ['userTools'] }]);
	});

	it('toolList：resetField 暂存恢复手势，保存走 unset', async () => {
		const fake = fakeScope({ value: { userTools: ['bash'] }, user: { userTools: ['bash'] } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		expect(face.hooks.dshQQCard.getSnapshot().fields.userTools.overridden).toBe(true);
		face.resetField('userTools');
		let state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.userTools.overridden).toBe(false);
		expect(state.fields.userTools.values).toEqual(['bash']);
		face.save('tools');
		await settle();
		expect(fake.committed[0]).toEqual([{ op: 'unset', path: ['userTools'] }]);
		state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.userTools.overridden).toBe(false);
	});

	it('toolList：describe 携带 schema 元数据时字段获得动态选项', () => {
		const fake = fakeScope({ value: { userTools: [] } });
		const envelope = {
			uid: 1,
			refs: {
				'1': { type: 'object', meta: {}, dict: { userTools: 2 } },
				'2': { type: 'array', meta: { dshqqToolOptions: ['bash', 'qq_send'] } },
			},
		};
		const describe = {
			getSnapshot: () => ({ status: 'ready' as const, view: { namespaces: [{ ns: 'dsh-qq-bot', schema: envelope }], writable: true } }),
			subscribe: () => () => {},
			ensure: () => Promise.resolve(),
		};
		const face = new DshQQCardController(fake.scope, describe).inject() as unknown as CardFace;
		expect(face.hooks.dshQQCard.getSnapshot().fields.userTools.options).toEqual(['bash', 'qq_send']);
		expect(face.hooks.dshQQCard.getSnapshot().fields.blockedTools.options).toBeUndefined();
	});

	it('modelSelect：未暂存时显示 provider/model 合成的规格串', () => {
		const fake = fakeScope({ value: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.memoryDistillModel.kind).toBe('modelSelect');
		expect(state.fields.memoryDistillModel.text).toBe('deepseek-official/deepseek-chat');
		expect(state.cards.memory.dirty).toBe(false);
	});

	it('modelSelect：任一段为空都显示为"部署默认"（空串）', () => {
		const onlyModel = fakeScope({ value: { memoryDistillProvider: '', memoryDistillModel: 'deepseek-chat' } });
		const face = new DshQQCardController(onlyModel.scope).inject() as unknown as CardFace;
		expect(face.hooks.dshQQCard.getSnapshot().fields.memoryDistillModel.text).toBe('');
		// 只有 provider（手改配置）：模型为空仍算"未指定"，不显示成半截规格串。
		const onlyProvider = fakeScope({ value: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: '' } });
		const face2 = new DshQQCardController(onlyProvider.scope).inject() as unknown as CardFace;
		expect(face2.hooks.dshQQCard.getSnapshot().fields.memoryDistillModel.text).toBe('');
	});

	it('modelSelect：一次选择同时写 provider 与 model 两个配置项', async () => {
		const fake = fakeScope({ value: { memoryDistillProvider: '', memoryDistillModel: '' } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageValue('memoryDistillModel', 'deepseek-official/deepseek-chat');
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.memory.dirty).toBe(true);
		expect(state.fields.memoryDistillModel.text).toBe('deepseek-official/deepseek-chat');
		expect(state.fields.memoryDistillModel.overridden).toBe(true);
		face.save('memory');
		await settle();
		expect(fake.committed[0]).toEqual([
			{ op: 'set', path: ['memoryDistillModel'], value: 'deepseek-chat' },
			{ op: 'set', path: ['memoryDistillProvider'], value: 'deepseek-official' },
		]);
	});

	it('modelSelect：模型 id 含斜杠时只按第一个斜杠切分 provider', async () => {
		const fake = fakeScope({ value: { memoryDistillProvider: '', memoryDistillModel: '' } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageValue('memoryDistillModel', 'openrouter/anthropic/claude-sonnet-4');
		face.save('memory');
		await settle();
		expect(fake.committed[0]).toEqual([
			{ op: 'set', path: ['memoryDistillModel'], value: 'anthropic/claude-sonnet-4' },
			{ op: 'set', path: ['memoryDistillProvider'], value: 'openrouter' },
		]);
	});

	it('modelSelect：选「部署默认」= 两个路径都退回组合层；无覆盖时不产生写入', async () => {
		const covered = fakeScope({
			value: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' },
			user: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' },
		});
		const face = new DshQQCardController(covered.scope).inject() as unknown as CardFace;
		face.stageValue('memoryDistillModel', '');
		expect(face.hooks.dshQQCard.getSnapshot().cards.memory.dirty).toBe(true);
		face.save('memory');
		await settle();
		expect(covered.committed[0]).toEqual([
			{ op: 'unset', path: ['memoryDistillModel'] },
			{ op: 'unset', path: ['memoryDistillProvider'] },
		]);

		// 组合层本来就没有覆盖（默认就是部署默认）→ 不产生任何写入。
		const bare = fakeScope({ value: { memoryDistillProvider: '', memoryDistillModel: '' } });
		const face2 = new DshQQCardController(bare.scope).inject() as unknown as CardFace;
		face2.stageValue('memoryDistillModel', '');
		expect(face2.hooks.dshQQCard.getSnapshot().cards.memory.dirty).toBe(false);
		face2.save('memory');
		await settle();
		expect(bare.committed).toHaveLength(0);
	});

	it('modelSelect：重选当前项不产生写入', async () => {
		const fake = fakeScope({
			value: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' },
			user: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' },
		});
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.stageValue('memoryDistillModel', 'deepseek-official/deepseek-chat');
		expect(face.hooks.dshQQCard.getSnapshot().cards.memory.dirty).toBe(false);
		face.save('memory');
		await settle();
		expect(fake.committed).toHaveLength(0);
	});

	it('modelSelect：resetField 把两个路径一起退回组合层', async () => {
		const fake = fakeScope({
			value: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' },
			user: { memoryDistillProvider: 'deepseek-official', memoryDistillModel: 'deepseek-chat' },
		});
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		expect(face.hooks.dshQQCard.getSnapshot().fields.memoryDistillModel.overridden).toBe(true);
		face.resetField('memoryDistillModel');
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.memoryDistillModel.text).toBe('');
		// 「恢复默认」是"退回组合层"手势：保存后不再有覆盖（与 toolList 同类语义）。
		expect(state.fields.memoryDistillModel.overridden).toBe(false);
		expect(state.cards.memory.dirty).toBe(true);
		face.save('memory');
		await settle();
		expect(fake.committed[0]).toEqual([
			{ op: 'unset', path: ['memoryDistillModel'] },
			{ op: 'unset', path: ['memoryDistillProvider'] },
		]);
	});

	it('discard：只清空所在卡的暂存', async () => {
		const fake = fakeScope({ value: { url: 'ws://a', debug: false } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('url', 'ws://b');
		face.stageValue('debug', true);
		face.discard('connection');
		let state = face.hooks.dshQQCard.getSnapshot();
		expect(state.fields.url.text).toBe('ws://a');
		expect(state.cards.logging.dirty).toBe(true);
		face.discard('logging');
		state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.logging.dirty).toBe(false);
	});

	it('保存成功后给出"已保存"回执（卡片保持展开），再次编辑即清除', async () => {
		const fake = fakeScope({ value: { url: 'ws://a' } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		expect(face.hooks.dshQQCard.getSnapshot().cards.connection.saved).toBe(false);
		face.edit('url', 'ws://b');
		expect(face.hooks.dshQQCard.getSnapshot().cards.connection.saved).toBe(false);
		face.save('connection');
		await settle();
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.connection).toMatchObject({ saved: true, failed: false, dirty: false });
		// 接着改下一项：回执让位给新的"未保存"草稿，卡片不会因此收起。
		face.edit('reconnectDelayMs', '5000');
		expect(face.hooks.dshQQCard.getSnapshot().cards.connection.saved).toBe(false);
	});

	it('保存失败不显示回执；discard 也清除回执', async () => {
		const fake = fakeScope({ value: { url: 'ws://a' } });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('url', 'ws://b');
		fake.scope.mutate = async () => {
			return;
		};
		face.save('connection');
		await settle();
		expect(face.hooks.dshQQCard.getSnapshot().cards.connection).toMatchObject({ saved: false, failed: true });

		const ok = fakeScope({ value: { url: 'ws://a' } });
		const face2 = new DshQQCardController(ok.scope).inject() as unknown as CardFace;
		face2.edit('url', 'ws://b');
		face2.save('connection');
		await settle();
		expect(face2.hooks.dshQQCard.getSnapshot().cards.connection.saved).toBe(true);
		face2.discard('connection');
		expect(face2.hooks.dshQQCard.getSnapshot().cards.connection.saved).toBe(false);
	});

	it('宿主拒绝写入时该卡 failed=true 且保留草稿', async () => {
		const fake = fakeScope({ value: { url: 'ws://a' } });
		// 模拟宿主拒绝：mutate 不落盘。
		fake.scope.mutate = async () => {
			return;
		};
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		face.edit('url', 'ws://b');
		face.save('connection');
		await settle();
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.cards.connection.failed).toBe(true);
		expect(state.fields.url.text).toBe('ws://b');
	});

	it('只读部署：writable=false', () => {
		const fake = fakeScope({ value: {}, writable: false });
		const face = new DshQQCardController(fake.scope).inject() as unknown as CardFace;
		const state = face.hooks.dshQQCard.getSnapshot();
		expect(state.writable).toBe(false);
	});
});
