/**
 * 配置页面组件：注册为独立 settings.section（设置左列顶级入口）。
 * 页面 = 标题/简介 + 每个分组一张折叠卡片，卡片交互与内置插件配置页的
 * 卡片一致（折叠头 + 简介 + 未保存角标 + 卡内暂存 + 卡底部保存/放弃）。
 * 结构与设计令牌（--dsw-alias-*）对齐内置样式，类名前缀 dshqq- 自持。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { readOpenCards, writeOpenCard } from './cards.ts';
import type { ReactNode } from 'react';
import type { FieldDef, FieldGroup, FieldState, CardShell, CardState } from './form.ts';
import { FIELD_GROUPS, CONNECTION_CARD_ID } from './form.ts';
import { fetchTransportConnected } from './connection.ts';
import { parseChatSelector } from '../persona/routes.ts';
import { addOrderItem, moveOrderItem, removeOrderItem } from '../search/priority.ts';
import { describeSchedule, normalizeRunAtInput, normalizeTimeInput, normalizeWeekdaysInput, WEEKDAY_LABELS, type TaskKind, type TaskSchedule } from '../tasks/schedule.ts';
import type { RpcCaller, Translate } from './types.ts';

const css = {
	section: 'dshqq-section',
	heading: 'dshqq-heading',
	intro: 'dshqq-intro',
	cards: 'dshqq-cards',
	sectionWrap: 'dshqq-sectionWrap',
	sectionHead: 'dshqq-sectionHead',
	subHead: 'dshqq-subHead',
	readOnly: 'dshqq-readOnly',
	empty: 'dshqq-empty',
	card: 'dshqq-card',
	cardOpen: 'dshqq-cardOpen',
	header: 'dshqq-header',
	headText: 'dshqq-headText',
	name: 'dshqq-name',
	description: 'dshqq-description',
	chevron: 'dshqq-chevron',
	chevronOpen: 'dshqq-chevronOpen',
	body: 'dshqq-body',
	footer: 'dshqq-footer',
	failed: 'dshqq-failed',
	saved: 'dshqq-saved',
	discard: 'dshqq-discard',
	save: 'dshqq-save',
	pending: 'dshqq-pending',
	field: 'dshqq-field',
	head: 'dshqq-head',
	label: 'dshqq-label',
	badges: 'dshqq-badges',
	badge: 'dshqq-badge',
	badgeMuted: 'dshqq-badgeMuted',
	conn: 'dshqq-conn',
	connDot: 'dshqq-connDot',
	reset: 'dshqq-reset',
	input: 'dshqq-input',
	inputInvalid: 'dshqq-inputInvalid',
	textarea: 'dshqq-textarea',
	select: 'dshqq-select',
	checkGrid: 'dshqq-checkGrid',
	checkItem: 'dshqq-checkItem',
	chipRow: 'dshqq-chipRow',
	chipRowLabel: 'dshqq-chipRowLabel',
	chip: 'dshqq-chip',
	chipRemove: 'dshqq-chipRemove',
	chipAdd: 'dshqq-chipAdd',
	orderList: 'dshqq-orderList',
	orderRow: 'dshqq-orderRow',
	orderIndex: 'dshqq-orderIndex',
	orderName: 'dshqq-orderName',
	orderOps: 'dshqq-orderOps',
	orderArrow: 'dshqq-orderArrow',
	orderRemove: 'dshqq-orderRemove',
	orderAdd: 'dshqq-orderAdd',
	invalid: 'dshqq-invalid',
	hint: 'dshqq-hint',
	toggleRow: 'dshqq-toggleRow',
	switch: 'dshqq-switch',
	switchOn: 'dshqq-switchOn',
	thumb: 'dshqq-thumb',
	logPanel: 'dshqq-logPanel',
	logToolbar: 'dshqq-logToolbar',
	logAutoOn: 'dshqq-logAutoOn',
	logStatus: 'dshqq-logStatus',
	logStatusLive: 'dshqq-logStatusLive',
	logDot: 'dshqq-logDot',
	logList: 'dshqq-logList',
	logRow: 'dshqq-logRow',
	logTime: 'dshqq-logTime',
	logDir: 'dshqq-logDir',
	logDirIn: 'dshqq-logDirIn',
	logDirOut: 'dshqq-logDirOut',
	logDirSys: 'dshqq-logDirSys',
	logScope: 'dshqq-logScope',
	logText: 'dshqq-logText',
	logEmpty: 'dshqq-logEmpty',
	editor: 'dshqq-editor',
	editorItem: 'dshqq-editorItem',
	editorHead: 'dshqq-editorHead',
	routeHead: 'dshqq-routeHead',
	routeRow: 'dshqq-routeRow',
	routeRowDefault: 'dshqq-routeRowDefault',
	routeDefaultLabel: 'dshqq-routeDefaultLabel',
	routeRemove: 'dshqq-routeRemove',
	taskHead: 'dshqq-taskHead',
	taskChat: 'dshqq-taskChat',
	taskSchedule: 'dshqq-taskSchedule',
	taskPrompt: 'dshqq-taskPrompt',
	taskMeta: 'dshqq-taskMeta',
	taskOps: 'dshqq-taskOps',
	taskWeek: 'dshqq-taskWeek',
} as const;

function cls(...names: Array<string | false | undefined>): string {
	return names.filter((name) => typeof name === 'string' && name !== '').join(' ');
}

export interface CardProps extends Record<string, unknown> {
	t: Translate;
	useDshQQCard: (selector: (state: CardState) => CardState) => CardState;
	edit: (key: string, text: string) => void;
	stageValue: (key: string, value: unknown) => void;
	stageList: (key: string, items: string[]) => void;
	stageClear: (key: string) => void;
	resetField: (key: string) => void;
	save: (cardId: string) => void;
	discard: (cardId: string) => void;
	/** 惰性取宿主 RPC 调用器（connection 服务晚于本插件就绪时每次拉取重取）。 */
	getRpc?: () => RpcCaller | undefined;
}

/** 消息日志条目（宿主 MessageLogEntry 的浏览器侧镜像）。 */
export interface LogEntryView {
	seq: number;
	ts: number;
	dir: 'in' | 'out' | 'sys';
	scope: 'onebot' | 'dsh' | 'pipeline' | 'search';
	event: string;
	chatType?: 'private' | 'group';
	chatId?: string;
	senderId?: string;
	senderName?: string;
	text: string;
	detail?: string;
}

const DIR_CLASS: Record<LogEntryView['dir'], string> = { in: css.logDirIn, out: css.logDirOut, sys: css.logDirSys };

/**
 * 宿主日志实时流路由（与宿主 logs/stream.ts 的 LOG_STREAM_PATH 一致；
 * 客户端 bundle 不能 import 宿主模块，故此处重复常量）。
 */
const LOG_STREAM_PATH = '/api/dsh-qq-bot/logs/stream';
/** 视图保留的条目数（与快照 limit 一致）。 */
const LOG_VIEW_MAX = 300;
/** 实时流不可用/断线期间的轮询间隔。 */
const LOG_POLL_MS = 4000;
/** 连接状态（连接卡片头部的"已连接"角标）轮询间隔：改完连接参数最多这么久可见结果。 */
const CONNECTION_POLL_MS = 4000;

function clockOf(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 已收到条目的最大 seq（实时帧据此检测服务端丢帧造成的缺口）。 */
function maxSeq(entries: LogEntryView[]): number {
	let max = 0;
	for (const entry of entries) {
		if (entry.seq > max) max = entry.seq;
	}
	return max;
}

/** 追加一条（seq 去重 + 裁剪到 LOG_VIEW_MAX 条）。 */
function appendEntry(prev: LogEntryView[], entry: LogEntryView): LogEntryView[] {
	if (prev.some((item) => item.seq === entry.seq)) return prev;
	const next = [...prev, entry];
	return next.length > LOG_VIEW_MAX ? next.slice(next.length - LOG_VIEW_MAX) : next;
}

/** 校验宿主返回的条目数组（防御跨版本字段变化）。 */
function parseEntries(value: unknown): LogEntryView[] {
	if (!Array.isArray(value)) return [];
	return value.filter((raw): raw is LogEntryView => {
		if (raw === null || typeof raw !== 'object') return false;
		const entry = raw as Partial<LogEntryView>;
		return typeof entry.seq === 'number' && typeof entry.ts === 'number' && typeof entry.text === 'string' && typeof entry.dir === 'string';
	}) as LogEntryView[];
}

function LogRow(props: { entry: LogEntryView; t: Translate }): ReactNode {
	const { entry, t } = props;
	const chat = entry.chatId === undefined ? t('logUnknownChat') : entry.chatType === 'group' ? `${t('logChatGroup')} ${entry.chatId}` : `${t('logChatPrivate')} ${entry.chatId}`;
	const sender = entry.senderName !== undefined && entry.senderName !== '' ? entry.senderName : entry.senderId;
	const full = entry.detail !== undefined && entry.detail !== '' ? `${entry.text}\n— ${entry.detail}` : entry.text;
	return (
		<li className={css.logRow} title={full}>
			<span className={css.logTime}>{clockOf(entry.ts)}</span>
			<span className={`${css.logDir} ${DIR_CLASS[entry.dir]}`}>{t(`logDir${entry.dir[0]!.toUpperCase()}${entry.dir.slice(1)}`)}</span>
			<span className={css.logScope}>{t(`logScope${entry.scope[0]!.toUpperCase()}${entry.scope.slice(1)}`)}</span>
			<span className={css.logText}>{sender !== undefined && sender !== '' ? `${chat} · ${sender}：${entry.text}` : `${chat}：${entry.text}`}</span>
		</li>
	);
}

/** 消息日志视图的共享状态（由配置 section 持有，折叠卡片不丢过滤/刷新设置）。 */
interface MessageLogState {
	entries: LogEntryView[];
	filter: string;
	setFilter: (value: string) => void;
	/** 实时更新开关（false = 暂停，仅保留手动刷新）。 */
	auto: boolean;
	setAuto: (value: boolean) => void;
	/** 实时流当前是否已连接（工具栏指示灯）。 */
	live: boolean;
	failed: string | null;
	refresh: () => void;
	clearAll: () => Promise<void>;
}

/**
 * 消息日志数据源：优先走宿主 `connection.fetch` 上的 SSE 实时流
 * （/api/dsh-qq-bot/logs/stream，与 /api 同级受浏览器 cookie 鉴权），
 * 新条目零延迟到达；流不可用（旧宿主 / EventSource 缺失）或断线期间自动
 * 退回 4s 轮询 `logs/recent`。只在日志卡片展开（active）且未暂停时订阅。
 *
 * 状态挂在调用方（配置 section）而非卡片内，所以收起/展开卡片不会重置
 * 过滤词与实时开关。
 */
function useMessageLog(getRpc: (() => RpcCaller | undefined) | undefined, active: boolean): MessageLogState {
	const [entries, setEntries] = useState<LogEntryView[]>([]);
	const [filter, setFilter] = useState('');
	const [auto, setAuto] = useState(true);
	const [live, setLive] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	/** 已收到的最新 seq：实时帧出现缺口（服务端丢帧）时触发整表重拉。 */
	const lastSeq = useRef(0);

	const fetchEntries = useCallback(
		async (signal: AbortSignal): Promise<void> => {
			const call = getRpc?.();
			if (call === undefined) return;
			const result = await call('logs/recent', { limit: LOG_VIEW_MAX });
			if (signal.aborted) return;
			if (!result.ok) {
				setFailed(result.error?.message ?? 'error');
				return;
			}
			setFailed(null);
			const list = parseEntries((result.value as { entries?: unknown } | undefined)?.entries);
			lastSeq.current = maxSeq(list);
			setEntries(list.slice(-LOG_VIEW_MAX));
		},
		[getRpc],
	);

	useEffect(() => {
		if (!active || !auto) {
			setLive(false);
			return;
		}
		const controller = new AbortController();
		let disposed = false;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		const stopPoll = (): void => {
			if (pollTimer === undefined) return;
			clearInterval(pollTimer);
			pollTimer = undefined;
		};
		/** 实时流未连接时的兜底轮询（旧宿主或断线重连期间）。 */
		const startPoll = (): void => {
			if (pollTimer !== undefined) return;
			void fetchEntries(controller.signal);
			pollTimer = setInterval(() => {
				void fetchEntries(controller.signal);
			}, LOG_POLL_MS);
		};

		const source = typeof EventSource === 'function' ? new EventSource(LOG_STREAM_PATH) : undefined;
		if (source === undefined) {
			startPoll();
		} else {
			const applySnapshot = (value: unknown): void => {
				const list = parseEntries(value);
				lastSeq.current = maxSeq(list);
				setEntries(list.slice(-LOG_VIEW_MAX));
			};
			const handleFrame = (payload: unknown): void => {
				if (payload === null || typeof payload !== 'object') return;
				const frame = payload as { kind?: unknown; entries?: unknown; entry?: unknown };
				if (frame.kind === 'snapshot') {
					setFailed(null);
					applySnapshot(frame.entries);
					return;
				}
				if (frame.kind === 'append') {
					const [entry] = parseEntries([frame.entry]);
					if (entry === undefined) return;
					// 服务端在客户端落后时丢过帧：seq 缺口 → 整表重拉补齐。
					if (lastSeq.current > 0 && entry.seq > lastSeq.current + 1) {
						void fetchEntries(controller.signal);
						return;
					}
					if (entry.seq > lastSeq.current) lastSeq.current = entry.seq;
					setEntries((prev) => appendEntry(prev, entry));
					return;
				}
				if (frame.kind === 'clear') {
					// seq 不回退：清空后新条目的 seq 仍与最后一条连续。
					setEntries([]);
					return;
				}
				if (frame.kind === 'resync') void fetchEntries(controller.signal);
			};
			source.onopen = (): void => {
				if (disposed) return;
				setLive(true);
				setFailed(null);
				stopPoll();
			};
			source.onerror = (): void => {
				if (disposed) return;
				// EventSource 自行重连；断线期间先靠轮询保住可见性。
				setLive(false);
				startPoll();
			};
			source.onmessage = (event: MessageEvent): void => {
				if (disposed) return;
				try {
					handleFrame(JSON.parse(String(event.data)) as unknown);
				} catch {
					// 非 JSON 帧（心跳是注释，不会进 onmessage）：忽略。
				}
			};
			// 首帧快照到达前先拉一次，避免连接建立期间空白。
			startPoll();
		}

		return () => {
			disposed = true;
			controller.abort();
			stopPoll();
			source?.close();
		};
	}, [active, auto, fetchEntries]);

	const refresh = useCallback((): void => {
		void fetchEntries(new AbortController().signal);
	}, [fetchEntries]);

	const clearAll = useCallback(async (): Promise<void> => {
		const call = getRpc?.();
		if (call === undefined) return;
		await call('logs/clear');
		setEntries([]);
	}, [getRpc]);

	return { entries, filter, setFilter, auto, setAuto, live, failed, refresh, clearAll };
}

/**
 * 消息日志视图（无卡片壳）：过滤框 + 暂停/刷新/清空 + 实时状态灯 + 条目列表。
 * 嵌在「消息日志」配置卡片的展开体里，与三个日志开关同卡。
 */
function LogViewerPanel(props: { t: Translate; log: MessageLogState }): ReactNode {
	const { t, log } = props;
	const needle = log.filter.trim().toLowerCase();
	const shown =
		needle === ''
			? log.entries
			: log.entries.filter((entry) =>
					`${entry.text}\n${entry.detail ?? ''}\n${entry.chatId ?? ''}\n${entry.senderId ?? ''}\n${entry.senderName ?? ''}`
						.toLowerCase()
						.includes(needle),
				);
	return (
		<div className={css.logPanel}>
			<div className={css.logToolbar}>
				<input
					className={css.input}
					type="text"
					value={log.filter}
					placeholder={t('logFilterPlaceholder')}
					onChange={(event) => {
						log.setFilter(event.target.value);
					}}
				/>
				<button
					type="button"
					className={cls(css.discard, log.auto && css.logAutoOn)}
					onClick={() => {
						log.setAuto(!log.auto);
					}}
				>
					{log.auto ? t('logPause') : t('logResumeLive')}
				</button>
				<button type="button" className={css.discard} onClick={log.refresh}>
					{t('logRefresh')}
				</button>
				<button type="button" className={css.discard} disabled={log.entries.length === 0} onClick={() => void log.clearAll()}>
					{t('logClear')}
				</button>
				<span className={cls(css.logStatus, log.auto && log.live && css.logStatusLive)} role="status">
					<span className={css.logDot} aria-hidden="true" />
					{!log.auto ? t('logPaused') : log.live ? t('logLive') : t('logPolling')}
				</span>
			</div>
			{log.failed !== null ? (
				<p className={css.failed} role="status">
					{t('logLoadFailed').replace('{message}', log.failed)}
				</p>
			) : null}
			{shown.length === 0 ? (
				<p className={css.logEmpty}>{t('logEmpty')}</p>
			) : (
				<ul className={css.logList}>
					{shown
						.slice()
						.reverse()
						.map((entry) => (
							<LogRow key={entry.seq} entry={entry} t={t} />
						))}
				</ul>
			)}
		</div>
	);
}

// ── 人格库 / 人格与模型（宿主 RPC 数据，不走 settings schema）──

/** 人格库条目（宿主 PersonaRecord 的浏览器镜像）。 */
export interface PersonaRecordView {
	name: string;
	prompt: string;
}

/** 「人格与模型」一行：chat 为 `friend_<QQ号>` / `group_<群号>`。 */
export interface RouteRowView {
	chat: string;
	persona?: string;
	model?: string;
}

/** 「默认会话」行：没有 chat（左列是固定文案），只存人格与模型。 */
export interface DefaultRowView {
	persona?: string;
	model?: string;
}

/** 模型下拉选项（spec = `provider/model`）。 */
export interface ModelOptionView {
	spec: string;
	provider: string;
	model: string;
	name: string;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function parsePersonaList(value: unknown): PersonaRecordView[] {
	const raw = value !== null && typeof value === 'object' ? (value as { personas?: unknown }) : {};
	if (!Array.isArray(raw.personas)) return [];
	return raw.personas
		.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
		.map((entry) => ({ name: asString(entry.name), prompt: asString(entry.prompt) }));
}

/** routes/list 应答 → 号码行 + 「默认会话」行 + 人格库默认名。 */
interface RouteViews {
	rows: RouteRowView[];
	defaultRow: DefaultRowView;
	libraryDefault: string;
}

function parseRouteViews(value: unknown): RouteViews {
	const raw = value !== null && typeof value === 'object' ? (value as { rows?: unknown; default?: unknown; libraryDefault?: unknown }) : {};
	const rows = Array.isArray(raw.rows)
		? raw.rows
				.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
				.map((entry) => {
					const row: RouteRowView = { chat: asString(entry.chat) };
					if (asString(entry.persona) !== '') row.persona = asString(entry.persona);
					if (asString(entry.model) !== '') row.model = asString(entry.model);
					return row;
				})
		: [];
	const source = raw.default !== null && typeof raw.default === 'object' ? (raw.default as Record<string, unknown>) : {};
	const defaultRow: DefaultRowView = {};
	if (asString(source.persona) !== '') defaultRow.persona = asString(source.persona);
	if (asString(source.model) !== '') defaultRow.model = asString(source.model);
	return { rows, defaultRow, libraryDefault: asString(raw.libraryDefault) };
}


function parseModelViews(value: unknown): ModelOptionView[] {
	const raw = value !== null && typeof value === 'object' ? (value as { models?: unknown }) : {};
	if (!Array.isArray(raw.models)) return [];
	return raw.models
		.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
		.map((entry) => ({ spec: asString(entry.spec), provider: asString(entry.provider), model: asString(entry.model), name: asString(entry.name) }))
		.filter((entry) => entry.spec !== '');
}

/** 人格库 / 人格与模型共享的数据源与保存动作。 */
interface PersonaModelData {
	status: 'idle' | 'loading' | 'ready' | 'error';
	failed: string | null;
	personas: PersonaRecordView[];
	/** 人格库默认人格（「默认会话」行人格留空时的回落值）。 */
	libraryDefault: string;
	rows: RouteRowView[];
	defaultRow: DefaultRowView;
	models: ModelOptionView[];
	reload: () => void;
	savePersonas: (personas: PersonaRecordView[]) => Promise<{ ok: boolean; error?: string }>;
	saveRows: (rows: RouteRowView[], defaultRow: DefaultRowView) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * 两张卡片共用一次加载：personas/list + routes/list + models/list。
 * 只在任一张卡片展开时首次拉取；保存后用宿主返回的新值刷新。
 */
function usePersonaModelData(getRpc: (() => RpcCaller | undefined) | undefined, active: boolean): PersonaModelData {
	const [status, setStatus] = useState<PersonaModelData['status']>('idle');
	const [failed, setFailed] = useState<string | null>(null);
	const [personas, setPersonas] = useState<PersonaRecordView[]>([]);
	const [libraryDefault, setLibraryDefault] = useState('');
	const [rows, setRows] = useState<RouteRowView[]>([]);
	const [defaultRow, setDefaultRow] = useState<DefaultRowView>({});
	const [models, setModels] = useState<ModelOptionView[]>([]);
	const loaded = useRef(false);

	const load = useCallback(async (): Promise<void> => {
		const call = getRpc?.();
		if (call === undefined) {
			setStatus('error');
			setFailed('RPC 不可用');
			return;
		}
		setStatus('loading');
		try {
			const [personasAnswer, routesAnswer, modelsAnswer] = await Promise.all([call('personas/list'), call('routes/list'), call('models/list')]);
			const firstError = !personasAnswer.ok ? personasAnswer : !routesAnswer.ok ? routesAnswer : undefined;
			if (firstError !== undefined && !firstError.ok) {
				setStatus('error');
				setFailed(firstError.error?.message ?? 'error');
				return;
			}
			setPersonas(parsePersonaList(personasAnswer.value));
			const routes = parseRouteViews(routesAnswer.value);
			setRows(routes.rows);
			setDefaultRow(routes.defaultRow);
			setLibraryDefault(routes.libraryDefault);
			setModels(modelsAnswer.ok ? parseModelViews(modelsAnswer.value) : []);
			setFailed(null);
			setStatus('ready');
		} catch (error) {
			setStatus('error');
			setFailed(error instanceof Error ? error.message : String(error));
		}
	}, [getRpc]);

	useEffect(() => {
		if (!active || loaded.current) return;
		loaded.current = true;
		void load();
	}, [active, load]);

	const reload = useCallback((): void => {
		void load();
	}, [load]);

	const savePersonas = useCallback(async (next: PersonaRecordView[]): Promise<{ ok: boolean; error?: string }> => {
		const call = getRpc?.();
		if (call === undefined) {
			setFailed('RPC 不可用');
			return { ok: false, error: 'RPC 不可用' };
		}
		const answer = await call('personas/save', { personas: next });
		if (!answer.ok) {
			const error = answer.error?.message ?? 'error';
			setFailed(error);
			return { ok: false, error };
		}
		setPersonas(parsePersonaList(answer.value));
		setFailed(null);
		return { ok: true };
	}, [getRpc]);

	const saveRows = useCallback(
		async (next: RouteRowView[], nextDefault: DefaultRowView): Promise<{ ok: boolean; error?: string }> => {
			const call = getRpc?.();
			if (call === undefined) {
				setFailed('RPC 不可用');
				return { ok: false, error: 'RPC 不可用' };
			}
			const answer = await call('routes/save', { rows: next, default: nextDefault });
			if (!answer.ok) {
				const error = answer.error?.message ?? 'error';
				setFailed(error);
				return { ok: false, error };
			}
			const routes = parseRouteViews(answer.value);
			setRows(routes.rows);
			setDefaultRow(routes.defaultRow);
			setLibraryDefault(routes.libraryDefault);
			setFailed(null);
			return { ok: true };
		},
		[getRpc],
	);

	return { status, failed, personas, libraryDefault, rows, defaultRow, models, reload, savePersonas, saveRows };
}

/**
 * 模型清单（宿主 `models/list`）：与「人格与模型」的模型列同源，供 settings
 * 卡片里的模型下拉（modelSelect，如「长期记忆」的蒸馏模型）使用。只在含该
 * 控件的卡片展开时拉一次；失败不算已加载，下次展开重试。
 *
 * 刻意不复用 usePersonaModelData 的 models：那个 hook 要 personas/list 与
 * routes/list 都成功才算 ready，人格库文件出问题时不该把蒸馏模型下拉一起
 * 降级成空清单。
 */
function useModelOptions(getRpc: (() => RpcCaller | undefined) | undefined, active: boolean): ModelOptionView[] {
	const [models, setModels] = useState<ModelOptionView[]>([]);
	const loaded = useRef(false);
	const pending = useRef(false);
	useEffect(() => {
		if (!active || loaded.current || pending.current) return;
		const call = getRpc?.();
		if (call === undefined) return;
		pending.current = true;
		void call('models/list')
			.then((answer) => {
				if (!answer.ok) return;
				setModels(parseModelViews(answer.value));
				loaded.current = true;
			})
			.catch(() => {})
			.finally(() => {
				pending.current = false;
			});
	}, [active, getRpc]);
	return models;
}

/** 人格库编辑面板（卡片展开体）。默认人格不在这里选（见「人格与模型」的默认会话行）。 */
function PersonaPanel(props: { t: Translate; data: PersonaModelData; disabled: boolean }): ReactNode {
	const { t, data, disabled } = props;
	const [draft, setDraft] = useState<PersonaRecordView[]>([]);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);

	// 宿主数据变化（首次加载 / 保存成功）时重置草稿。
	useEffect(() => {
		setDraft(data.personas.map((entry) => ({ ...entry })));
	}, [data.personas]);

	const named = draft.map((entry) => entry.name.trim());
	const duplicate = named.some((name, index) => name !== '' && named.indexOf(name) !== index);
	const missingName = draft.some((entry) => entry.name.trim() === '' && entry.prompt.trim() !== '');
	const dirty = JSON.stringify(draft) !== JSON.stringify(data.personas.map((entry) => ({ name: entry.name, prompt: entry.prompt })));
	const invalid = duplicate || missingName;

	if (data.status === 'loading' || data.status === 'idle') return <p className={css.hint}>{t('loading')}</p>;
	if (data.status === 'error') {
		return (
			<div className={css.logPanel}>
				<p className={css.failed} role="status">
					{t('loadFailed').replace('{message}', data.failed ?? '')}
				</p>
				<div className={css.footer}>
					<button type="button" className={css.discard} onClick={data.reload}>
						{t('retry')}
					</button>
				</div>
			</div>
		);
	}

	const patch = (index: number, next: Partial<PersonaRecordView>): void => {
		setDraft((prev) => prev.map((entry, at) => (at === index ? { ...entry, ...next } : entry)));
	};

	const save = async (): Promise<void> => {
		if (disabled || saving || invalid) return;
		setSaving(true);
		setFailed(null);
		// 空名条目直接丢弃；名称去掉首尾空白。
		const records = draft
			.filter((entry) => entry.name.trim() !== '')
			.map((entry) => ({ name: entry.name.trim(), prompt: entry.prompt }));
		const result = await data.savePersonas(records);
		setSaving(false);
		if (!result.ok) setFailed(result.error ?? null);
	};

	return (
		<div className={css.editor}>
			{draft.length === 0 ? <p className={css.hint}>{t('personaEmpty')}</p> : null}
			{draft.map((entry, index) => (
				<div className={css.editorItem} key={index}>
					<div className={css.editorHead}>
						<input
							className={entry.name.trim() === '' && entry.prompt.trim() !== '' ? cls(css.input, css.inputInvalid) : css.input}
							type="text"
							value={entry.name}
							placeholder={t('personaNamePlaceholder')}
							disabled={disabled || saving}
							onChange={(event) => {
								patch(index, { name: event.target.value });
							}}
						/>
						<button
							type="button"
							className={css.reset}
							disabled={disabled || saving}
							onClick={() => {
								setDraft((prev) => prev.filter((_, at) => at !== index));
							}}
						>
							{t('personaRemove')}
						</button>
					</div>
					<textarea
						className={cls(css.input, css.textarea)}
						value={entry.prompt}
						placeholder={t('personaPromptPlaceholder')}
						disabled={disabled || saving}
						onChange={(event) => {
							patch(index, { prompt: event.target.value });
						}}
					/>
				</div>
			))}
			<div className={css.chipAdd}>
				<button
					type="button"
					className={css.discard}
					disabled={disabled || saving}
					onClick={() => {
						setDraft((prev) => [...prev, { name: '', prompt: '' }]);
					}}
				>
					{t('personaAdd')}
				</button>
			</div>
			<p className={invalid ? css.invalid : css.hint}>
				{invalid ? t(duplicate ? 'personaDuplicate' : 'personaNameRequired') : t('personaPanelHint')}
			</p>
			{failed !== null ? (
				<p className={css.failed} role="status">
					{t('saveFailedDetail').replace('{message}', failed)}
				</p>
			) : null}
			<div className={css.footer}>
				<button
					type="button"
					className={css.discard}
					disabled={!dirty || saving}
					onClick={() => {
						setDraft(data.personas.map((entry) => ({ ...entry })));
						setFailed(null);
					}}
				>
					{t('discard')}
				</button>
				<button type="button" className={css.save} disabled={disabled || !dirty || invalid || saving} onClick={() => void save()}>
					{t(saving ? 'saving' : 'save')}
				</button>
			</div>
		</div>
	);
}

/** 号码行 → 可比较的规范形（去空白、空值省略）。脏检查与保存共用。 */
function normalizeRouteRow(row: RouteRowView): RouteRowView {
	const out: RouteRowView = { chat: row.chat.trim() };
	if ((row.persona ?? '') !== '') out.persona = row.persona;
	if ((row.model ?? '') !== '') out.model = row.model;
	return out;
}

/** 「默认会话」行 → 可比较的规范形（不参与号码校验）。 */
function normalizeDefaultRow(row: DefaultRowView): DefaultRowView {
	const out: DefaultRowView = {};
	if ((row.persona ?? '') !== '') out.persona = row.persona;
	if ((row.model ?? '') !== '') out.model = row.model;
	return out;
}

/** 「人格与模型」表格面板：第一行固定「默认会话」，其余每行左填会话、中选人格、右选模型。 */
function RoutePanel(props: { t: Translate; data: PersonaModelData; disabled: boolean }): ReactNode {
	const { t, data, disabled } = props;
	const [draft, setDraft] = useState<RouteRowView[]>([]);
	const [defaultDraft, setDefaultDraft] = useState<DefaultRowView>({});
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);

	useEffect(() => {
		setDraft(data.rows.map((row) => ({ ...row })));
		setDefaultDraft({ ...data.defaultRow });
	}, [data.rows, data.defaultRow]);

	const named = draft.map((row) => row.chat.trim());
	const hasContent = (row: RouteRowView): boolean => row.chat.trim() !== '' || (row.persona ?? '') !== '' || (row.model ?? '') !== '';
	const badChat = draft.some((row) => hasContent(row) && parseChatSelector(row.chat) === null);
	const missingChat = draft.some((row) => row.chat.trim() === '' && ((row.persona ?? '') !== '' || (row.model ?? '') !== ''));
	const keys = named.filter((chat) => chat !== '').map((chat) => parseChatSelector(chat)?.key ?? chat);
	const duplicate = keys.some((key, index) => keys.indexOf(key) !== index);
	const invalid = badChat || missingChat || duplicate;
	const dirty =
		JSON.stringify(draft.map(normalizeRouteRow)) !== JSON.stringify(data.rows.map(normalizeRouteRow)) ||
		JSON.stringify(normalizeDefaultRow(defaultDraft)) !== JSON.stringify(normalizeDefaultRow(data.defaultRow));

	if (data.status === 'loading' || data.status === 'idle') return <p className={css.hint}>{t('loading')}</p>;
	if (data.status === 'error') {
		return (
			<div className={css.logPanel}>
				<p className={css.failed} role="status">
					{t('loadFailed').replace('{message}', data.failed ?? '')}
				</p>
				<div className={css.footer}>
					<button type="button" className={css.discard} onClick={data.reload}>
						{t('retry')}
					</button>
				</div>
			</div>
		);
	}

	const patch = (index: number, next: Partial<RouteRowView>): void => {
		setDraft((prev) => prev.map((row, at) => (at === index ? { ...row, ...next } : row)));
	};

	const personaNames = data.personas.map((entry) => entry.name);

	const save = async (): Promise<void> => {
		if (disabled || saving || invalid) return;
		setSaving(true);
		setFailed(null);
		const rows = draft.filter((row) => hasContent(row) && parseChatSelector(row.chat) !== null).map(normalizeRouteRow);
		const saved = await data.saveRows(rows, normalizeDefaultRow(defaultDraft));
		setSaving(false);
		if (!saved.ok) setFailed(saved.error ?? null);
	};

	const invalidMessage = badChat ? 'routeInvalidChat' : missingChat ? 'routeChatRequired' : duplicate ? 'routeDuplicateChat' : 'routePanelHint';

	// 「默认会话」行：左列是固定文案，人格/模型两列与号码行同栅格（人格留空 = 跟随人格库默认）。
	const defaultPersona = defaultDraft.persona ?? '';
	const defaultModel = defaultDraft.model ?? '';
	const defaultPersonaOptions = defaultPersona !== '' && !personaNames.includes(defaultPersona) ? [defaultPersona, ...personaNames] : personaNames;
	const defaultModelOptions = defaultModel !== '' && !data.models.some((entry) => entry.spec === defaultModel) ? [{ spec: defaultModel, name: defaultModel }, ...data.models] : data.models;

	return (
		<div className={css.editor}>
			{/* 列标题 + 固定「默认会话」行 + 号码行共用同一套栅格（含末列 28px），保证三列严格对齐。 */}
			<div className={css.routeHead}>
				<span>{t('routeColChat')}</span>
				<span>{t('routeColPersona')}</span>
				<span>{t('routeColModel')}</span>
			</div>
			<div className={css.routeRowDefault}>
				<span className={css.routeDefaultLabel}>{t('routeDefaultChat')}</span>
				<select
					className={cls(css.input, css.select)}
					value={defaultPersona}
					disabled={disabled || saving}
					onChange={(event) => {
						setDefaultDraft((prev) => ({ ...prev, persona: event.target.value }));
					}}
				>
					<option value="">{data.libraryDefault === '' ? t('routePersonaLibraryDefault') : t('routePersonaLibraryDefaultNamed').replace('{name}', data.libraryDefault)}</option>
					{defaultPersonaOptions.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
				<select
					className={cls(css.input, css.select)}
					value={defaultModel}
					disabled={disabled || saving}
					onChange={(event) => {
						setDefaultDraft((prev) => ({ ...prev, model: event.target.value }));
					}}
				>
					<option value="">{t('routeModelDefault')}</option>
					{defaultModelOptions.map((option) => (
						<option key={option.spec} value={option.spec}>
							{modelOptionText(option)}
						</option>
					))}
				</select>
			</div>
			{draft.length === 0 ? <p className={css.hint}>{t('routeEmpty')}</p> : null}
			{draft.map((row, index) => {
				const personaValue = row.persona ?? '';
				const modelValue = row.model ?? '';
				const personaOptions = personaValue !== '' && !personaNames.includes(personaValue) ? [personaValue, ...personaNames] : personaNames;
				const modelOptions = modelValue !== '' && !data.models.some((entry) => entry.spec === modelValue) ? [{ spec: modelValue, name: modelValue }, ...data.models] : data.models;
				return (
					<div className={css.routeRow} key={index}>
						<input
							className={parseChatSelector(row.chat) === null && row.chat.trim() !== '' ? cls(css.input, css.inputInvalid) : css.input}
							type="text"
							value={row.chat}
							placeholder={t('routeChatPlaceholder')}
							disabled={disabled || saving}
							onChange={(event) => {
								patch(index, { chat: event.target.value });
							}}
						/>
						<select
							className={cls(css.input, css.select)}
							value={personaValue}
							disabled={disabled || saving}
							onChange={(event) => {
								patch(index, { persona: event.target.value });
							}}
						>
							<option value="">{t('routePersonaNone')}</option>
							{personaOptions.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</select>
						<select
							className={cls(css.input, css.select)}
							value={modelValue}
							disabled={disabled || saving}
							onChange={(event) => {
								patch(index, { model: event.target.value });
							}}
						>
							<option value="">{t('routeModelDefault')}</option>
							{modelOptions.map((option) => (
								<option key={option.spec} value={option.spec}>
									{modelOptionText(option)}
								</option>
							))}
						</select>
						<button
							type="button"
							className={css.routeRemove}
							disabled={disabled || saving}
							aria-label={t('routeRemove')}
							onClick={() => {
								setDraft((prev) => prev.filter((_, at) => at !== index));
							}}
						>
							×
						</button>
					</div>
				);
			})}
			<div className={css.chipAdd}>
				<button
					type="button"
					className={css.discard}
					disabled={disabled || saving}
					onClick={() => {
						setDraft((prev) => [...prev, { chat: '' }]);
					}}
				>
					{t('routeAdd')}
				</button>
			</div>
			<p className={invalid ? css.invalid : css.hint}>{t(invalidMessage)}</p>
			{data.models.length === 0 ? <p className={css.hint}>{t('routeModelsEmpty')}</p> : null}
			{failed !== null ? (
				<p className={css.failed} role="status">
					{t('saveFailedDetail').replace('{message}', failed)}
				</p>
			) : null}
			<div className={css.footer}>
				<button
					type="button"
					className={css.discard}
					disabled={!dirty || saving}
					onClick={() => {
						setDraft(data.rows.map((row) => ({ ...row })));
						setDefaultDraft({ ...data.defaultRow });
						setFailed(null);
					}}
				>
					{t('discard')}
				</button>
				<button type="button" className={css.save} disabled={disabled || !dirty || invalid || saving} onClick={() => void save()}>
					{t(saving ? 'saving' : 'save')}
				</button>
			</div>
		</div>
	);
}

/** 定时任务卡片一行的浏览器面（宿主 TaskView 的镜像；时间戳为 epoch ms）。 */
export interface TaskRecordView {
	id: string;
	chat: string;
	chatKey: string;
	chatType: 'private' | 'group';
	chatId: string;
	prompt: string;
	note: string;
	kind: TaskKind;
	time: string;
	weekdays: number[];
	runAt: string;
	enabled: boolean;
	createdBy: string;
	createdAt: number;
	lastRunAt: number | null;
	nextRunAt: number | null;
}

/** TaskView → 时间表（describeSchedule 的入参）。 */
function scheduleOf(view: TaskRecordView): TaskSchedule {
	if (view.kind === 'once') return { kind: 'once', runAt: view.runAt };
	if (view.kind === 'weekly') return { kind: 'weekly', time: view.time, weekdays: view.weekdays };
	return { kind: 'daily', time: view.time };
}

function parseTaskViews(value: unknown): TaskRecordView[] {
	const raw = value !== null && typeof value === 'object' ? (value as { tasks?: unknown }) : {};
	if (!Array.isArray(raw.tasks)) return [];
	return raw.tasks
		.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
		.map((entry) => ({
			id: asString(entry.id),
			chat: asString(entry.chat),
			chatKey: asString(entry.chatKey),
			chatType: entry.chatType === 'group' ? 'group' as const : 'private' as const,
			chatId: asString(entry.chatId),
			prompt: asString(entry.prompt),
			note: asString(entry.note),
			kind: entry.kind === 'once' ? ('once' as const) : entry.kind === 'weekly' ? ('weekly' as const) : ('daily' as const),
			time: asString(entry.time),
			weekdays: Array.isArray(entry.weekdays) ? entry.weekdays.filter((day): day is number => typeof day === 'number') : [],
			runAt: asString(entry.runAt),
			enabled: entry.enabled === true,
			createdBy: asString(entry.createdBy),
			createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
			lastRunAt: typeof entry.lastRunAt === 'number' ? entry.lastRunAt : null,
			nextRunAt: typeof entry.nextRunAt === 'number' ? entry.nextRunAt : null,
		}))
		.filter((entry) => entry.id !== '');
}

/** 定时任务卡片共享的数据源与操作（单任务操作，不整表替换）。 */
interface TaskData {
	status: 'idle' | 'loading' | 'ready' | 'error';
	failed: string | null;
	tasks: TaskRecordView[];
	reload: () => void;
	upsert: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
	remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
	toggle: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
	run: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

/** 定时任务数据源：只在卡片展开时首次拉取；每次操作后用宿主返回的全量列表刷新。 */
function useTaskData(getRpc: (() => RpcCaller | undefined) | undefined, active: boolean): TaskData {
	const [status, setStatus] = useState<TaskData['status']>('idle');
	const [failed, setFailed] = useState<string | null>(null);
	const [tasks, setTasks] = useState<TaskRecordView[]>([]);
	const loaded = useRef(false);

	const load = useCallback(async (): Promise<void> => {
		const call = getRpc?.();
		if (call === undefined) {
			setStatus('error');
			setFailed('RPC 不可用');
			return;
		}
		setStatus('loading');
		try {
			const answer = await call('tasks/list');
			if (!answer.ok) {
				setStatus('error');
				setFailed(answer.error?.message ?? 'error');
				return;
			}
			setTasks(parseTaskViews(answer.value));
			setFailed(null);
			setStatus('ready');
		} catch (error) {
			setStatus('error');
			setFailed(error instanceof Error ? error.message : String(error));
		}
	}, [getRpc]);

	useEffect(() => {
		if (!active || loaded.current) return;
		loaded.current = true;
		void load();
	}, [active, load]);

	const reload = useCallback((): void => {
		void load();
	}, [load]);

	const op = useCallback(
		async (endpoint: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
			const call = getRpc?.();
			if (call === undefined) {
				setFailed('RPC 不可用');
				return { ok: false, error: 'RPC 不可用' };
			}
			const answer = await call(endpoint, payload);
			if (!answer.ok) {
				const error = answer.error?.message ?? 'error';
				setFailed(error);
				return { ok: false, error };
			}
			setTasks(parseTaskViews(answer.value));
			setFailed(null);
			return { ok: true };
		},
		[getRpc],
	);

	return {
		status,
		failed,
		tasks,
		reload,
		upsert: (payload) => op('tasks/upsert', payload),
		remove: (id) => op('tasks/delete', { id }),
		toggle: (id, enabled) => op('tasks/toggle', { id, enabled }),
		run: (id) => op('tasks/run', { id }),
	};
}

/** 定时任务的编辑草稿（id 缺省 = 新建）。 */
interface TaskDraft {
	id?: string;
	chat: string;
	kind: TaskKind;
	time: string;
	weekdays: number[];
	runAt: string;
	prompt: string;
	note: string;
}

function draftOf(view: TaskRecordView): TaskDraft {
	return { id: view.id, chat: view.chat, kind: view.kind, time: view.time, weekdays: view.weekdays, runAt: view.runAt, prompt: view.prompt, note: view.note };
}

/** epoch ms → 本地 `MM-DD HH:mm`（任务列表展示用）。 */
function formatStamp(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 定时任务面板（卡片展开体）：列表 + 单任务操作（启停/立即执行/编辑/删除），
 * 编辑走暂存草稿（保存才落库）；新建/编辑是同一个表单。与「人格与模型」
 * 不同，列表不做整表替换——agent 会在会话里并发建任务，这里只做单任务操作，
 * 每次操作后用宿主返回的全量列表刷新。
 */
function TaskPanel(props: { t: Translate; data: TaskData; disabled: boolean }): ReactNode {
	const { t, data, disabled } = props;
	const [editing, setEditing] = useState<TaskDraft | null>(null);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);

	if (data.status === 'loading' || data.status === 'idle') return <p className={css.hint}>{t('loading')}</p>;
	if (data.status === 'error') {
		return (
			<div className={css.logPanel}>
				<p className={css.failed} role="status">
					{t('loadFailed').replace('{message}', data.failed ?? '')}
				</p>
				<div className={css.footer}>
					<button type="button" className={css.discard} onClick={data.reload}>
						{t('retry')}
					</button>
				</div>
			</div>
		);
	}

	const validate = (draft: TaskDraft): string | null => {
		if (parseChatSelector(draft.chat) === null) return t('taskInvalidChat');
		if (draft.prompt.trim() === '') return t('taskPromptRequired');
		if (draft.kind === 'once') {
			if (normalizeRunAtInput(draft.runAt) === null) return t('taskRunAtRequired');
		} else if (normalizeTimeInput(draft.time) === null) return t('taskTimeRequired');
		if (draft.kind === 'weekly' && normalizeWeekdaysInput(draft.weekdays) === null) return t('taskWeekdaysRequired');
		return null;
	};

	const save = async (): Promise<void> => {
		if (editing === null || disabled || saving) return;
		const problem = validate(editing);
		if (problem !== null) {
			setFailed(problem);
			return;
		}
		setSaving(true);
		setFailed(null);
		const result = await data.upsert({
			...(editing.id !== undefined ? { id: editing.id } : {}),
			chat: editing.chat.trim(),
			prompt: editing.prompt.trim(),
			note: editing.note.trim(),
			kind: editing.kind,
			...(editing.kind === 'once' ? { runAt: editing.runAt.trim().replace('T', ' ') } : { time: editing.time.trim() }),
			...(editing.kind === 'weekly' ? { weekdays: editing.weekdays } : {}),
		});
		setSaving(false);
		if (result.ok) setEditing(null);
		else setFailed(result.error ?? null);
	};

	// 新建/编辑共用的表单体：会话选择器 + 周期 + 任务内容 + 备注。
	const renderForm = (draft: TaskDraft, isNew: boolean): ReactNode => (
		<div className={css.editorItem}>
			<div className={css.taskHead}>
				<input
					className={parseChatSelector(draft.chat) === null && draft.chat.trim() !== '' ? cls(css.input, css.inputInvalid) : css.input}
					type="text"
					value={draft.chat}
					placeholder={t('taskChatPlaceholder')}
					disabled={disabled || saving}
					onChange={(event) => {
						setEditing((prev) => (prev === null ? prev : { ...prev, chat: event.target.value }));
					}}
				/>
				<select
					className={cls(css.input, css.select)}
					value={draft.kind}
					disabled={disabled || saving}
					onChange={(event) => {
						setEditing((prev) => (prev === null ? prev : { ...prev, kind: event.target.value as TaskKind }));
					}}
				>
					{(['once', 'daily', 'weekly'] as const).map((kind) => (
						<option key={kind} value={kind}>
							{t(`taskKind.${kind}`)}
						</option>
					))}
				</select>
			</div>
			{draft.kind === 'once' ? (
				<input
					className={normalizeRunAtInput(draft.runAt) === null && draft.runAt !== '' ? cls(css.input, css.inputInvalid) : css.input}
					type="datetime-local"
					value={draft.runAt.replace(' ', 'T')}
					disabled={disabled || saving}
					onChange={(event) => {
						setEditing((prev) => (prev === null ? prev : { ...prev, runAt: event.target.value.replace('T', ' ') }));
					}}
				/>
			) : (
				<>
					<input
						className={normalizeTimeInput(draft.time) === null && draft.time !== '' ? cls(css.input, css.inputInvalid) : css.input}
						type="time"
						value={draft.time}
						disabled={disabled || saving}
						onChange={(event) => {
							setEditing((prev) => (prev === null ? prev : { ...prev, time: event.target.value }));
						}}
					/>
					{draft.kind === 'weekly' ? (
						<div className={css.taskWeek} role="group" aria-label={t('taskWeekdays')}>
							{WEEKDAY_LABELS.map((label, day) => {
								const on = draft.weekdays.includes(day);
								return (
									<label key={day} className={css.checkItem}>
										<input
											type="checkbox"
											checked={on}
											disabled={disabled || saving}
											onChange={(event) => {
												const next = event.target.checked ? [...draft.weekdays, day] : draft.weekdays.filter((value) => value !== day);
												setEditing((prev) => (prev === null ? prev : { ...prev, weekdays: next }));
											}}
										/>
										<span>{t('taskWeekday').replace('{day}', label)}</span>
									</label>
								);
							})}
						</div>
					) : null}
				</>
			)}
			<textarea
				className={cls(css.input, css.textarea)}
				value={draft.prompt}
				placeholder={t('taskPromptPlaceholder')}
				disabled={disabled || saving}
				onChange={(event) => {
					setEditing((prev) => (prev === null ? prev : { ...prev, prompt: event.target.value }));
				}}
			/>
			<input
				className={css.input}
				type="text"
				value={draft.note}
				placeholder={t('taskNotePlaceholder')}
				disabled={disabled || saving}
				onChange={(event) => {
					setEditing((prev) => (prev === null ? prev : { ...prev, note: event.target.value }));
				}}
			/>
			{failed !== null ? (
				<p className={css.failed} role="status">
					{t('saveFailedDetail').replace('{message}', failed)}
				</p>
			) : null}
			<div className={css.footer}>
				<button
					type="button"
					className={css.discard}
					disabled={saving}
					onClick={() => {
						setEditing(null);
						setFailed(null);
					}}
				>
					{t(isNew ? 'taskCancelNew' : 'taskCancelEdit')}
				</button>
				<button type="button" className={css.save} disabled={disabled || saving || validate(draft) !== null} onClick={() => void save()}>
					{t(saving ? 'saving' : 'save')}
				</button>
			</div>
		</div>
	);

	return (
		<div className={css.editor}>
			{editing !== null ? renderForm(editing, editing.id === undefined) : null}
			{editing === null ? (
				<div className={css.chipAdd}>
					<button
						type="button"
						className={css.discard}
						disabled={disabled}
						onClick={() => {
							setFailed(null);
							setEditing({ chat: '', kind: 'daily', time: '', weekdays: [1, 2, 3, 4, 5], runAt: '', prompt: '', note: '' });
						}}
					>
						{t('taskAdd')}
					</button>
				</div>
			) : null}
			{data.tasks.length === 0 && editing === null ? <p className={css.hint}>{t('taskEmpty')}</p> : null}
			{data.tasks.map((task) => {
				if (editing?.id === task.id) return null;
				return (
					<div className={css.editorItem} key={task.id}>
						<div className={css.taskHead}>
							<span className={css.taskChat}>{task.chat}</span>
							<span className={css.taskSchedule}>{describeSchedule(scheduleOf(task))}</span>
							<button
								type="button"
								role="switch"
								aria-checked={task.enabled}
								aria-label={t('taskEnabledLabel')}
								className={cls(css.switch, task.enabled && css.switchOn)}
								disabled={disabled || saving}
								onClick={() => {
									void data.toggle(task.id, !task.enabled);
								}}
							>
								<span className={css.thumb} />
							</button>
						</div>
						<p className={css.taskPrompt}>{task.note !== '' ? `${task.note}：${task.prompt}` : task.prompt}</p>
						<p className={css.taskMeta}>
							{task.enabled
								? task.nextRunAt !== null
									? t('taskNextRun').replace('{time}', formatStamp(task.nextRunAt))
									: t('taskExpired')
								: t('taskDisabledLabel')}
							{task.lastRunAt !== null ? ` · ${t('taskLastRun').replace('{time}', formatStamp(task.lastRunAt))}` : ''}
						</p>
						<div className={css.taskOps}>
							<button
								type="button"
								className={css.discard}
								disabled={disabled || saving}
								onClick={() => {
									void data.run(task.id);
								}}
							>
								{t('taskRun')}
							</button>
							<button
								type="button"
								className={css.discard}
								disabled={disabled || saving}
								onClick={() => {
									setFailed(null);
									setEditing(draftOf(task));
								}}
							>
								{t('taskEdit')}
							</button>
							<button
								type="button"
								className={css.discard}
								disabled={disabled || saving}
								onClick={() => {
									void data.remove(task.id);
								}}
							>
								{t('taskDelete')}
							</button>
						</div>
					</div>
				);
			})}
			{editing === null && (failed !== null || data.failed !== null) ? (
				<p className={css.failed} role="status">
					{t('saveFailedDetail').replace('{message}', data.failed ?? failed ?? '')}
				</p>
			) : null}
			<p className={css.hint}>{t('taskPanelHint')}</p>
		</div>
	);
}

interface RowProps {
	def: FieldDef;
	state: FieldState;
	t: Translate;
	disabled: boolean;
	/**
	 * 模型下拉（modelSelect）的选项：宿主 `models/list` 的运行时清单，
	 * 与「人格与模型」卡片的模型列同源（见 useModelOptions）。
	 */
	modelOptions?: readonly ModelOptionView[];
	onEdit: (key: string, text: string) => void;
	onStageValue: (key: string, value: unknown) => void;
	onStageList: (key: string, items: string[]) => void;
	onReset: (key: string) => void;
	onStageClear: (key: string) => void;
}

/**
 * 头部：label + 覆盖时的「恢复默认」。
 * user 层有覆盖时不再显示"已覆盖"角标（保存后满屏角标噪音太大），
 * 只保留就地恢复默认的入口。
 */
function FieldHead(props: RowProps & { htmlFor: string }): ReactNode {
	const { def, state, t, disabled } = props;
	return (
		<div className={css.head}>
			<label className={css.label} htmlFor={props.htmlFor}>
				{t(`${def.key}Label`)}
			</label>
			{state.overridden ? (
				<span className={css.badges}>
					<button
						type="button"
						className={css.reset}
						disabled={disabled}
						onClick={() => {
							props.onReset(def.key);
						}}
					>
						{t('reset')}
					</button>
				</span>
			) : null}
		</div>
	);
}

/** 文本/数字/列表/多行文本输入。 */
function TextRow(props: RowProps & { multiline?: boolean }): ReactNode {
	const { def, state, t, disabled } = props;
	const id = `dshqq-config-${def.key}`;
	// 列表类字段留空时的提示不同：list 是"每行一项"，lineList 是单行逗号分隔。
	const hintKey =
		state.text === '' && def.kind === 'list'
			? 'listEmpty'
			: state.text === '' && def.kind === 'lineList'
				? 'lineListEmpty'
				: `${def.key}Hint`;
	return (
		<div className={css.field}>
			<FieldHead {...props} htmlFor={id} />
			{props.multiline === true ? (
				<textarea
					id={id}
					className={cls(css.input, css.textarea)}
					value={state.text}
					disabled={disabled}
					onChange={(event) => {
						props.onEdit(def.key, event.target.value);
					}}
				/>
			) : (
				<input
					id={id}
					className={state.invalid ? cls(css.input, css.inputInvalid) : css.input}
					type="text"
					inputMode={def.kind === 'number' ? 'numeric' : undefined}
					aria-invalid={state.invalid || undefined}
					value={state.text}
					disabled={disabled}
					onChange={(event) => {
						props.onEdit(def.key, event.target.value);
					}}
				/>
			)}
			<p className={state.invalid ? css.invalid : css.hint}>{state.invalid ? t('invalidNumber') : t(hintKey)}</p>
		</div>
	);
}

/** 下拉选择（enum）。 */
function SelectRow(props: RowProps): ReactNode {
	const { def, state, t, disabled } = props;
	const id = `dshqq-config-${def.key}`;
	return (
		<div className={css.field}>
			<FieldHead {...props} htmlFor={id} />
			<select
				id={id}
				className={cls(css.input, css.select)}
				value={state.text}
				disabled={disabled}
				onChange={(event) => {
					props.onStageValue(def.key, event.target.value);
				}}
			>
				{state.options?.map((option) => (
					<option key={option} value={option}>
						{t(`${def.key}.${option}`)}
					</option>
				))}
			</select>
			<p className={css.hint}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/** 模型下拉的选项文案：`名称（provider/model）`；没有别名时只显示规格串。 */
function modelOptionText(option: { spec: string; name: string }): string {
	return option.name === '' || option.name === option.spec ? option.spec : `${option.name}（${option.spec}）`;
}

/**
 * 模型下拉（modelSelect）：与「人格与模型」卡片的模型列**同一份清单与文案**
 * （宿主 models/list = dsh「设置 → 模型」的运行时清单）。值型是 `provider/model`
 * 规格串，空 = 部署默认模型；一次选择同时写 provider 与 model 两个配置项
 * （见 form.ts 的 planModelWrite）。
 *
 * 清单为空（旧宿主 / llm 服务缺失）时只留「部署默认」一项并给出提示——与
 * 「人格与模型」的行为一致，不退回文本框（模型 id 无法凭空猜）。
 */
function ModelSelectRow(props: RowProps): ReactNode {
	const { def, state, t, disabled } = props;
	const id = `dshqq-config-${def.key}`;
	const options = props.modelOptions ?? [];
	// 当前值不在清单里（模型已下线 / 手改配置）时补一项，否则下拉会显示成第一项。
	const listed = state.text !== '' && !options.some((option) => option.spec === state.text);
	const all = listed ? [{ spec: state.text, provider: '', model: '', name: state.text }, ...options] : options;
	return (
		<div className={css.field}>
			<FieldHead {...props} htmlFor={id} />
			<select
				id={id}
				className={cls(css.input, css.select)}
				value={state.text}
				disabled={disabled}
				onChange={(event) => {
					props.onStageValue(def.key, event.target.value);
				}}
			>
				<option value="">{t(`${def.key}Default`)}</option>
				{all.map((option) => (
					<option key={option.spec} value={option.spec}>
						{modelOptionText(option)}
					</option>
				))}
			</select>
			<p className={css.hint}>{t(`${def.key}Hint`)}</p>
			{options.length === 0 ? <p className={css.hint}>{t('routeModelsEmpty')}</p> : null}
		</div>
	);
}

/**
 * 工具多选（toolList）：已知工具勾选框网格 + 其他条目（通配模式）chips。
 * 草稿顺序规范化为"已知选项顺序在前、额外条目按加入顺序在后"，同样的
 * 选择集合无论点选顺序如何都生成同一条目，避免无意义的覆盖写入。
 */
function ToolListRow(props: RowProps): ReactNode {
	const { def, state, t, disabled } = props;
	const options = state.options ?? [];
	const values = state.values ?? [];
	const selected = new Set(values);
	const extras = values.filter((value) => !options.includes(value));
	const [draft, setDraft] = useState('');
	const checkedKnown = () => options.filter((option) => selected.has(option));

	const toggle = (option: string, on: boolean) => {
		const next = new Set(selected);
		if (on) next.add(option);
		else next.delete(option);
		props.onStageList(def.key, [...options.filter((entry) => next.has(entry)), ...extras]);
	};

	const addDraft = () => {
		const entry = draft.trim();
		if (entry === '') return;
		setDraft('');
		if (options.includes(entry)) {
			if (selected.has(entry)) return;
			props.onStageList(def.key, [...options.filter((option) => selected.has(option) || option === entry), ...extras]);
			return;
		}
		if (extras.includes(entry)) return;
		props.onStageList(def.key, [...checkedKnown(), ...extras, entry]);
	};

	const addId = `dshqq-config-${def.key}-add`;
	return (
		<div className={css.field}>
			<FieldHead {...props} htmlFor={addId} />
			<div className={css.checkGrid} role="group" aria-label={t(`${def.key}Label`)}>
				{options.map((option) => (
					<label key={option} className={css.checkItem}>
						<input
							type="checkbox"
							checked={selected.has(option)}
							disabled={disabled}
							onChange={(event) => {
								toggle(option, event.target.checked);
							}}
						/>
						<span>{option}</span>
					</label>
				))}
			</div>
			{extras.length > 0 ? (
				<div className={css.chipRow}>
					<span className={css.chipRowLabel}>{t('toolListCustom')}</span>
					{extras.map((entry) => (
						<span key={entry} className={css.chip}>
							{entry}
							<button
								type="button"
								className={css.chipRemove}
								disabled={disabled}
								aria-label={`${t('toolListRemove')}: ${entry}`}
								onClick={() => {
									props.onStageList(def.key, [...checkedKnown(), ...extras.filter((extra) => extra !== entry)]);
								}}
							>
								×
							</button>
						</span>
					))}
				</div>
			) : null}
			<div className={css.chipAdd}>
				<input
					id={addId}
					className={css.input}
					type="text"
					value={draft}
					placeholder={t('toolListCustomPlaceholder')}
					disabled={disabled}
					onChange={(event) => {
						setDraft(event.target.value);
					}}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							addDraft();
						}
					}}
				/>
				<button
					type="button"
					className={css.discard}
					disabled={disabled || draft.trim() === ''}
					onClick={addDraft}
				>
					{t('toolListAdd')}
				</button>
			</div>
			<p className={css.hint}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/**
 * 顺序列表（orderList）：值是有序字符串数组，顺序本身有语义。
 *
 * 每行 = 序号 + 名称 + 右侧的「上移 / 下移 / 移出列表」按钮；列表下方是
 * 「加入列表」按钮（只列还没加入的选项），加进来的项默认排在末尾。
 * 不在列表里 = 不参与（对应旧配置里的 none），空列表由 hint 说明后果。
 * 暂存走与其他列表字段同一条通路（onStageList → 卡内保存），所以排序、
 * 移出、加入都随卡片一起保存/放弃，不会即时写盘。
 */
function OrderListRow(props: RowProps): ReactNode {
	const { def, state, t, disabled } = props;
	const options = state.options ?? [];
	const items = state.values ?? [];
	const missing = options.filter((option) => !items.includes(option));
	const label = (entry: string): string => t(`${def.key}.${entry}`);
	const stage = (next: readonly string[]): void => {
		props.onStageList(def.key, [...next]);
	};
	return (
		<div className={css.field}>
			{/* 列表不是可标注（labelable）控件，所以头部与 SwitchRow 一样自己渲染 label + 恢复默认。 */}
			<div className={css.head}>
				<span className={css.label}>{t(`${def.key}Label`)}</span>
				{state.overridden ? (
					<span className={css.badges}>
						<button
							type="button"
							className={css.reset}
							disabled={disabled}
							onClick={() => {
								props.onReset(def.key);
							}}
						>
							{t('reset')}
						</button>
					</span>
				) : null}
			</div>
			<ol className={css.orderList} role="group" aria-label={t(`${def.key}Label`)}>
				{items.map((entry, index) => (
					<li key={entry} className={css.orderRow}>
						<span className={css.orderIndex}>{index + 1}</span>
						<span className={css.orderName}>{label(entry)}</span>
						<span className={css.orderOps}>
							<button
								type="button"
								className={css.orderArrow}
								disabled={disabled || index === 0}
								aria-label={`${t('orderMoveUp')}: ${label(entry)}`}
								title={t('orderMoveUp')}
								onClick={() => {
									stage(moveOrderItem(items, index, -1));
								}}
							>
								↑
							</button>
							<button
								type="button"
								className={css.orderArrow}
								disabled={disabled || index === items.length - 1}
								aria-label={`${t('orderMoveDown')}: ${label(entry)}`}
								title={t('orderMoveDown')}
								onClick={() => {
									stage(moveOrderItem(items, index, 1));
								}}
							>
								↓
							</button>
							<button
								type="button"
								className={css.orderRemove}
								disabled={disabled}
								aria-label={`${t('orderRemove')}: ${label(entry)}`}
								title={t('orderRemove')}
								onClick={() => {
									stage(removeOrderItem(items, entry));
								}}
							>
								×
							</button>
						</span>
					</li>
				))}
			</ol>
			{items.length === 0 ? <p className={css.hint}>{t('orderListEmpty')}</p> : null}
			{missing.length > 0 ? (
				<div className={css.chipRow}>
					<span className={css.chipRowLabel}>{t('orderAddLabel')}</span>
					{missing.map((option) => (
						<button
							key={option}
							type="button"
							className={css.orderAdd}
							disabled={disabled}
							onClick={() => {
								stage(addOrderItem(items, option));
							}}
						>
							{t('orderAdd')} {label(option)}
						</button>
					))}
				</div>
			) : null}
			<p className={css.hint}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/** 开关（boolean）。 */
function SwitchRow(props: RowProps): ReactNode {	const { def, state, t, disabled } = props;
	return (
		<div className={css.field}>
			<div className={css.toggleRow}>
				<span className={css.label}>{t(`${def.key}Label`)}</span>
				<span className={css.badges}>
					{state.overridden ? (
						<button
							type="button"
							className={css.reset}
							disabled={disabled}
							onClick={() => {
								props.onReset(def.key);
							}}
						>
							{t('reset')}
						</button>
					) : null}
					<button
						type="button"
						role="switch"
						aria-checked={state.checked}
						aria-label={t(`${def.key}Label`)}
						className={cls(css.switch, state.checked && css.switchOn)}
						disabled={disabled}
						onClick={() => {
							props.onStageValue(def.key, !state.checked);
						}}
					>
						<span className={css.thumb} />
					</button>
				</span>
			</div>
			<p className={css.hint}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/** 只写密钥（secret）：不回显，留空 = 保持不变，另有显式清除手势。 */
function SecretRow(props: RowProps): ReactNode {
	const { def, state, t, disabled } = props;
	const id = `dshqq-config-${def.key}`;
	return (
		<div className={css.field}>
			<div className={css.head}>
				<label className={css.label} htmlFor={id}>
					{t(`${def.key}Label`)}
				</label>
				<span className={css.badges}>
					{state.clearStaged ? (
						<span className={css.badge}>{t('clearStored')}</span>
					) : (
						<button
							type="button"
							className={css.reset}
							disabled={disabled}
							onClick={() => {
								props.onStageClear(def.key);
							}}
						>
							{t('clearStored')}
						</button>
					)}
				</span>
			</div>
			<input
				id={id}
				className={css.input}
				type="password"
				autoComplete="off"
				value={state.text}
				disabled={disabled}
				onChange={(event) => {
					props.onEdit(def.key, event.target.value);
				}}
			/>
			<p className={css.hint}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

function FieldRow(props: RowProps): ReactNode {
	switch (props.def.kind) {
		case 'boolean':
			return <SwitchRow {...props} />;
		case 'enum':
			return <SelectRow {...props} />;
		case 'secret':
			return <SecretRow {...props} />;
		case 'toolList':
			// 宿主 schema 未携带工具选项（装载早期/旧宿主）→ 回退为每行一项的文本框。
			return (props.state.options?.length ?? 0) > 0 ? <ToolListRow {...props} /> : <TextRow {...props} multiline />;
		case 'orderList':
			// 选项由 FieldDef.options 给出（不依赖宿主 schema 元数据），所以无需回退；
			// 没有选项时列表恒为空，hint 会说明"列表为空"的后果。
			return <OrderListRow {...props} />;
		case 'modelSelect':
			// 选项来自宿主 models/list（组件经 props 注入，见 useModelOptions）。
			return <ModelSelectRow {...props} />;
		case 'list':
		case 'text':
			return <TextRow {...props} multiline />;
		case 'lineList':
			// 值型同 list（字符串数组），但控件是单行输入（逗号分隔）。
			return <TextRow {...props} />;
		default:
			return <TextRow {...props} />;
	}
}

/**
 * 连接状态：每 CONNECTION_POLL_MS 轮询宿主 `status/connection`，返回
 * "当前是否已连接"。宿主没有 RPC（旧宿主 / 非 web profile）时恒为 false
 * = 不显示角标；配置页只在打开时挂载，所以轮询只在设置页可见时发生。
 */
function useTransportConnected(getRpc: (() => RpcCaller | undefined) | undefined): boolean {
	const [connected, setConnected] = useState(false);
	useEffect(() => {
		if (getRpc === undefined) return;
		let disposed = false;
		const tick = async (): Promise<void> => {
			const call = getRpc();
			if (call === undefined) return;
			const next = await fetchTransportConnected(call);
			if (!disposed) setConnected(next);
		};
		void tick();
		const timer = setInterval(() => {
			void tick();
		}, CONNECTION_POLL_MS);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [getRpc]);
	return connected;
}

/** 连接卡片头部的"已连接"角标（未连接时不渲染）。 */
function ConnectedBadge(props: { t: Translate }): ReactNode {
	return (
		<span className={css.conn} role="status">
			<span className={css.connDot} aria-hidden="true" />
			{props.t('connected')}
		</span>
	);
}

/**
 * 一张分组折叠卡片（对齐内置 PluginCard）：折叠头（标题 + 简介 + 未保存
 * 角标 + 旋转箭头），展开为字段与卡内保存/放弃。暂存跨折叠保留；保存
 * 成功后自动收起。
 *
 * 折叠态由父级持有（open/onOpenChange）：日志卡片的视图状态挂在 section
 * 上，需要知道卡片是否展开来决定是否轮询。
 */
function GroupCard(
	props: CardProps & {
		group: FieldGroup;
		state: CardState;
		open: boolean;
		onOpenChange: (id: string, open: boolean) => void;
		/** 字段之后、保存按钮之前的附加内容（如日志卡片内嵌的日志视图）。 */
		extra?: ReactNode;
		/** 折叠头部的附加角标（如日志条数）。 */
		extraBadge?: ReactNode;
		/** 自定义交互卡片（人格库 / 人格与模型）的展开体：替代字段列表与保存栏。 */
		customBody?: ReactNode;
		/** 模型下拉（modelSelect）的选项（宿主 models/list）。 */
		modelOptions?: readonly ModelOptionView[];
	},
): ReactNode {
	const { group, state, open, onOpenChange } = props;
	const custom = group.custom !== undefined;
	const shell: CardShell = state.cards[group.id] ?? { dirty: false, invalid: false, saving: false, failed: false, saved: false };
	const saveStarted = useRef(false);
	useEffect(() => {
		if (custom) return;
		if (shell.saving) {
			saveStarted.current = true;
			return;
		}
		if (!saveStarted.current) return;
		saveStarted.current = false;
		if (!shell.dirty && !shell.failed) onOpenChange(group.id, false);
	}, [custom, onOpenChange, group.id, shell.dirty, shell.failed, shell.saving]);
	if (!state.available) return null;
	const disabled = !state.writable || shell.saving;
	const blocked = !shell.dirty || shell.invalid || shell.saving;
	// 卡内子分节：同一个标签只在首次出现处插一次小标题（form.ts 约定一张卡
	// 里同一标签必须连续，若再次出现会渲染第二个小标题）。
	const rows: ReactNode[] = [];
	let lastSub: string | undefined;
	for (const def of group.fields) {
		if (def.sub !== undefined && def.sub !== lastSub) {
			rows.push(
				<h4 key={`sub:${def.sub}`} className={css.subHead}>
					{props.t(def.sub)}
				</h4>,
			);
		}
		lastSub = def.sub;
		const fieldState = state.fields[def.key];
		if (fieldState === undefined) continue;
		rows.push(
			<FieldRow
				key={def.key}
				def={def}
				state={fieldState}
				t={props.t}
				disabled={disabled}
				modelOptions={props.modelOptions}
				onEdit={props.edit}
				onStageValue={props.stageValue}
				onStageList={props.stageList}
				onReset={props.resetField}
				onStageClear={props.stageClear}
			/>,
		);
	}
	return (
		<li className={cls(css.card, open && css.cardOpen)}>
			<button
				type="button"
				className={css.header}
				aria-expanded={open}
				aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${props.t(group.titleKey)}`}
				onClick={() => {
					onOpenChange(group.id, !open);
				}}
			>
				<span className={css.headText}>
					<span className={css.name}>{props.t(group.titleKey)}</span>
					<span className={css.description}>{props.t(group.descKey)}</span>
				</span>
				{props.extraBadge}
				{!custom && shell.dirty ? <span className={css.pending}>{props.t('unsaved')}</span> : null}
				<svg
					className={cls(css.chevron, open && css.chevronOpen)}
					width="14"
					height="14"
					viewBox="0 0 14 14"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M3.5 5.25 7 8.75l3.5-3.5"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open ? (
				<div className={css.body}>
					{custom ? (
						props.customBody
					) : (
						<>
							{rows}
							{props.extra}
					<div className={css.footer}>
						{shell.failed ? (
							<p className={css.failed} role="status">
								{props.t('saveFailed')}
							</p>
						) : shell.saved ? (
							// 保存成功的回执就地显示在底部：卡片**不收起**，用户能直接
							// 接着改下一项（历史行为：保存后卡片自己收起来，容易被当成
							// "点保存把面板关了"）。
							<p className={css.saved} role="status">
								{props.t('savedNotice')}
							</p>
						) : null}
						<button
							type="button"
							className={css.discard}
							disabled={!shell.dirty || shell.saving}
							onClick={() => {
								props.discard(group.id);
							}}
						>
							{props.t('discard')}
						</button>
						<button
							type="button"
							className={css.save}
							disabled={blocked}
							onClick={() => {
								props.save(group.id);
							}}
						>
							{props.t(shell.saving ? 'saving' : 'save')}
						</button>
					</div>
						</>
					)}
				</div>
			) : null}
		</li>
	);
}

/**
 * QQ（napcat）配置页（settings.section 组件）。
 *
 * 命名空间不可用（宿主未注册 settings 命名空间）时渲染 nothing，与其他
 * settings surface 的约定一致。页面是一列折叠卡片，按 FIELD_GROUPS 的
 * sectionKey 分成「接入与安全 / 对话体验 / 运行与维护」三段；一张卡 = 一个
 * 功能域，私聊/群聊的差异是卡内子分节（h4 小标题），不再各占一张卡。
 * 「消息日志与诊断」卡片的展开体里内嵌只读日志视图（宿主提供 connection RPC 时）。
 */
export function DshQQSection(props: CardProps): ReactNode {
	const state = props.useDshQQCard((snapshot) => snapshot);
	// 折叠态**不在组件 useState 里**：保存会改 settings 文档、宿主会重渲染
	// 设置面板，一旦本 section 被重挂载，组件内状态清零 —— 现象就是"点保存
	// 卡片自己收起来了"。展开态因此存在 client/cards.ts（模块级内存 +
	// sessionStorage），重挂载与刷新都保持；日志视图状态（过滤词/暂停开关/
	// 条目）仍随折叠保留在下面这些 hook 里，且只有日志卡片展开时才订阅实时流。
	const [openCards, setOpenCardsState] = useState<Record<string, boolean>>(readOpenCards);
	const setCardOpen = useCallback((id: string, next: boolean): void => {
		writeOpenCard(id, next);
		setOpenCardsState((prev) => (prev[id] === next ? prev : next ? { ...prev, [id]: true } : { ...prev, [id]: false }));
	}, []);
	const getRpc = props.getRpc as (() => RpcCaller | undefined) | undefined;
	// connection 服务缺失（旧宿主/非 web profile）时隐藏日志视图；每次渲染
	// 惰性解析一次（只是属性读取），兼容服务晚于本插件就绪的情况。
	// 注意：connection 不在 inject 声明里，index.ts 的取用必须走 .get() 并吞错。
	const rpcAvailable = getRpc !== undefined && getRpc() !== undefined;
	const logGroupId = FIELD_GROUPS.find((group) => group.logViewer === true)?.id;
	const log = useMessageLog(getRpc, rpcAvailable && logGroupId !== undefined && openCards[logGroupId] === true);
	// 人格库 / 人格与模型共用一份宿主数据；任一张卡片展开时首次拉取。
	const personaCardsOpen = FIELD_GROUPS.some(
		(group) => (group.custom === 'personas' || group.custom === 'routes') && openCards[group.id] === true,
	);
	const personaData = usePersonaModelData(getRpc, personaCardsOpen);
	// 模型下拉（modelSelect，长期记忆的蒸馏模型）：选项来自宿主 models/list，
	// 与「人格与模型」的模型列同源；只在含该控件的卡片展开时拉取。
	const modelCardsOpen = FIELD_GROUPS.some(
		(group) => group.fields.some((def) => def.kind === 'modelSelect') && openCards[group.id] === true,
	);
	const modelOptions = useModelOptions(getRpc, rpcAvailable && modelCardsOpen);
	// 定时任务列表独立加载（同样只在卡片展开时拉取）。
	const tasksCardOpen = FIELD_GROUPS.some((group) => group.custom === 'tasks' && openCards[group.id] === true);
	const taskData = useTaskData(getRpc, rpcAvailable && tasksCardOpen);
	// 连接状态角标：不需要展开卡片，折叠态就在头部可见。
	const transportConnected = useTransportConnected(getRpc);
	if (!state.available) return null;
	return (
		<div className={css.section}>
			<h2 className={css.heading}>{props.t('title')}</h2>
			<p className={css.intro}>{props.t('description')}</p>
			{!state.writable ? (
				<p className={css.readOnly} role="status">
					{props.t('readOnly')}
				</p>
			) : null}
			<ul className={css.cards}>
				{FIELD_GROUPS.map((group, index) => {
					// 顶层分区标题：只在分区变化处插一次（同一分区的卡片必须
					// 相邻，见 form.ts 的 FieldGroup.sectionKey）。
					const prevSection = index > 0 ? FIELD_GROUPS[index - 1]?.sectionKey : undefined;
					const sectionHead =
						group.sectionKey !== undefined && group.sectionKey !== prevSection ? (
							<li key={`section:${group.sectionKey}`} className={css.sectionWrap} role="presentation">
								<h3 className={css.sectionHead}>{props.t(group.sectionKey)}</h3>
							</li>
						) : null;
					const withViewer = group.logViewer === true && rpcAvailable;
					// 连接卡片：仅在确实连上 OneBot 对接端时显示"已连接"角标。
					const connectedBadge = group.id === CONNECTION_CARD_ID && transportConnected ? <ConnectedBadge t={props.t} /> : undefined;
					const countBadge =
						withViewer && log.entries.length > 0 ? (
							<span className={css.pending}>{props.t('logCount').replace('{count}', String(log.entries.length))}</span>
						) : undefined;
					const customBody =
						group.custom === 'personas' ? (
							<PersonaPanel t={props.t} data={personaData} disabled={!state.writable} />
						) : group.custom === 'routes' ? (
							<RoutePanel t={props.t} data={personaData} disabled={!state.writable} />
						) : group.custom === 'tasks' ? (
							rpcAvailable ? (
								<TaskPanel t={props.t} data={taskData} disabled={!state.writable} />
							) : (
								<p className={css.hint}>{props.t('taskRpcUnavailable')}</p>
							)
						) : undefined;
					return (
						<Fragment key={group.id}>
							{sectionHead}
							<GroupCard
								{...props}
								group={group}
								state={state}
								open={openCards[group.id] === true}
								onOpenChange={setCardOpen}
								extra={withViewer ? <LogViewerPanel t={props.t} log={log} /> : undefined}
								extraBadge={connectedBadge ?? countBadge}
								customBody={customBody}
								modelOptions={modelOptions}
							/>
						</Fragment>
					);
				})}
			</ul>
		</div>
	);
}
