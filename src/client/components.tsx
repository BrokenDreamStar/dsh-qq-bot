/**
 * 配置页面组件：注册为独立 settings.section（设置左列顶级入口）。
 * 页面 = 左侧功能域导航 + 右侧单张编辑卡；保存栏吸顶，长分类按子分节折叠。
 * 结构对齐内置样式，类名前缀 dshqq- 自持。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readActiveCard, writeActiveCard } from './cards.ts';
import { chatFieldMode, chatOptionText, MANUAL_CHAT_OPTION, parseChatOptions, type ChatOptionView } from './chatPicker.ts';
import type { ReactNode } from 'react';
import type { FieldDef, FieldGroup, FieldState, CardShell, CardState } from './form.ts';
import { FIELD_GROUPS, CONNECTION_CARD_ID } from './form.ts';
import { fetchTransportConnected } from './connection.ts';
import { toolLabel } from './locales.ts';
import { parseChatSelector } from '../persona/routes.ts';
import { addOrderItem, moveOrderItem, removeOrderItem } from '../search/priority.ts';
import { describeSchedule, normalizeRunAtInput, normalizeTimeInput, normalizeWeekdaysInput, WEEKDAY_LABELS, type TaskKind, type TaskSchedule } from '../tasks/schedule.ts';
import { normalizeTaskDelivery, taskTemplateError, type TaskDelivery } from '../tasks/template.ts';
import type { RpcCaller, Translate } from './types.ts';

const css = {
	section: 'dshqq-section',
	heading: 'dshqq-heading',
	intro: 'dshqq-intro',
	cards: 'dshqq-cards',
	sectionWrap: 'dshqq-sectionWrap',
	sectionHead: 'dshqq-sectionHead',
	subHead: 'dshqq-subHead',
	subsection: 'dshqq-subsection',
	subsectionHead: 'dshqq-subsectionHead',
	subsectionCount: 'dshqq-subsectionCount',
	subsectionBody: 'dshqq-subsectionBody',
	/** 自定义卡片里的多个子分节（如「人格」卡的会话人格 / 模板库）。 */
	panelStack: 'dshqq-panelStack',
	layout: 'dshqq-layout',
	nav: 'dshqq-nav',
	navSection: 'dshqq-navSection',
	navGroup: 'dshqq-navGroup',
	navItem: 'dshqq-navItem',
	navItemActive: 'dshqq-navItemActive',
	navItemText: 'dshqq-navItemText',
	navDot: 'dshqq-navDot',
	content: 'dshqq-content',
	saveBar: 'dshqq-saveBar',
	saveActions: 'dshqq-saveActions',
	modelGrid: 'dshqq-modelGrid',
	modelGridHead: 'dshqq-modelGridHead',
	modelCard: 'dshqq-modelCard',
	modelTitle: 'dshqq-modelTitle',
	modelAction: 'dshqq-modelAction',
	modelName: 'dshqq-modelName',
	modelInstalled: 'dshqq-modelInstalled',
	modelProgress: 'dshqq-modelProgress',
	modelBar: 'dshqq-modelBar',
	modelBarFill: 'dshqq-modelBarFill',
	modelBarFillBusy: 'dshqq-modelBarFillBusy',
	modelPercent: 'dshqq-modelPercent',
	modelState: 'dshqq-modelState',
	modelStateOk: 'dshqq-modelStateOk',
	modelStateBusy: 'dshqq-modelStateBusy',
	modelStateError: 'dshqq-modelStateError',
	modelStateOff: 'dshqq-modelStateOff',
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
	readonlyValue: 'dshqq-readonlyValue',
	reset: 'dshqq-reset',
	input: 'dshqq-input',
	inputInvalid: 'dshqq-inputInvalid',
	textarea: 'dshqq-textarea',
	select: 'dshqq-select',
	checkGrid: 'dshqq-checkGrid',
	checkItem: 'dshqq-checkItem',
	checkName: 'dshqq-checkName',
	checkId: 'dshqq-checkId',
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
	fieldHint: 'dshqq-fieldHint',
	toggleRow: 'dshqq-toggleRow',
	switch: 'dshqq-switch',
	switchOn: 'dshqq-switchOn',
	thumb: 'dshqq-thumb',
	logPanel: 'dshqq-logPanel',
	progressWrap: 'dshqq-progressWrap',
	progressTrack: 'dshqq-progressTrack',
	progressBar: 'dshqq-progressBar',
	progressIndeterminate: 'dshqq-progressIndeterminate',
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
	routeRow: 'dshqq-routeRow',
	routeRowDefault: 'dshqq-routeRowDefault',
	routeLine: 'dshqq-routeLine',
	routeFieldLabel: 'dshqq-routeFieldLabel',
	routeDefaultLabel: 'dshqq-routeDefaultLabel',
	routeRemove: 'dshqq-routeRemove',
	routeChat: 'dshqq-routeChat',
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
				setFailed(result.error?.message ?? '操作失败');
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

// ── 人格库 / 会话模型设置（宿主 RPC 数据，不走 settings schema）──

/** 人格库条目（宿主 PersonaRecord 的浏览器镜像）。 */
export interface PersonaRecordView {
	name: string;
	prompt: string;
}

/** 「会话模型设置」一行：chat 为 `friend_<QQ号>` / `group_<群号>`。 */
export interface RouteRowView {
	chat: string;
	model?: string;
	/** 思考强度 id（适配器自有；空 = 模型默认）。 */
	effort?: string;
}

/** 「默认会话」行：没有 chat（左列是固定文案），只存模型与思考强度。 */
export interface DefaultRowView {
	model?: string;
	effort?: string;
}

/** 思考强度选项（宿主 ModelEffortOption 的浏览器镜像）。 */
export interface ModelEffortView {
	id: string;
	name: string;
	description?: string;
}

/** 模型下拉选项（spec = `provider/model`）。 */
export interface ModelOptionView {
	spec: string;
	provider: string;
	model: string;
	name: string;
	/** 该模型可选的思考强度（空 = 模型不支持或宿主没有元数据）。 */
	efforts: ModelEffortView[];
	/** 适配器默认强度。 */
	defaultEffort?: string;
	/** 部署默认模型（模型留空时用它补强度清单）。 */
	isDefault?: boolean;
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

/** routes/list 应答 → 号码行 + 「默认会话」行 + 人格库默认名 + 会话下拉选项。 */
interface RouteViews {
	rows: RouteRowView[];
	defaultRow: DefaultRowView;
	libraryDefault: string;
	chats: ChatOptionView[];
}

function parseRouteViews(value: unknown): RouteViews {
	const raw = value !== null && typeof value === 'object' ? (value as { rows?: unknown; default?: unknown; libraryDefault?: unknown }) : {};
	const rows = Array.isArray(raw.rows)
		? raw.rows
				.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
				.map((entry) => {
					const row: RouteRowView = { chat: asString(entry.chat) };
					if (asString(entry.model) !== '') row.model = asString(entry.model);
					if (asString(entry.effort) !== '') row.effort = asString(entry.effort);
					return row;
				})
		: [];
	const source = raw.default !== null && typeof raw.default === 'object' ? (raw.default as Record<string, unknown>) : {};
	const defaultRow: DefaultRowView = {};
	if (asString(source.model) !== '') defaultRow.model = asString(source.model);
	if (asString(source.effort) !== '') defaultRow.effort = asString(source.effort);
	return { rows, defaultRow, libraryDefault: asString(raw.libraryDefault), chats: parseChatOptions(value) };
}


function parseModelViews(value: unknown): ModelOptionView[] {
	const raw = value !== null && typeof value === 'object' ? (value as { models?: unknown }) : {};
	if (!Array.isArray(raw.models)) return [];
	return raw.models
		.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
		.map((entry) => {
			const option: ModelOptionView = {
				spec: asString(entry.spec),
				provider: asString(entry.provider),
				model: asString(entry.model),
				name: asString(entry.name),
				efforts: Array.isArray(entry.efforts)
					? entry.efforts
							.filter((effort): effort is Record<string, unknown> => effort !== null && typeof effort === 'object')
							.map((effort) => ({
								id: asString(effort.id),
								name: asString(effort.name) !== '' ? asString(effort.name) : asString(effort.id),
								...(asString(effort.description) === '' ? {} : { description: asString(effort.description) }),
							}))
							.filter((effort) => effort.id !== '')
					: [],
			};
			if (asString(entry.defaultEffort) !== '') option.defaultEffort = asString(entry.defaultEffort);
			if (entry.isDefault === true) option.isDefault = true;
			return option;
		})
		.filter((entry) => entry.spec !== '');
}

/** 人格库 / 会话模型设置共享的数据源与保存动作。 */
interface PersonaModelData {
	status: 'idle' | 'loading' | 'ready' | 'error';
	failed: string | null;
	personas: PersonaRecordView[];
	/** 人格库默认人格（「默认会话」行人格留空时的回落值）。 */
	libraryDefault: string;
	rows: RouteRowView[];
	defaultRow: DefaultRowView;
	models: ModelOptionView[];
	/** 「会话模型设置」的会话下拉（群 / 好友 + 已有会话）。 */
	chats: ChatOptionView[];
	reload: () => void;
	savePersonas: (personas: PersonaRecordView[]) => Promise<{ ok: boolean; error?: string }>;
	saveRows: (rows: RouteRowView[], defaultRow: DefaultRowView) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * 两张卡片共用一次加载：personas/list + routes/list + models/list。
 * 只在任一张卡片展开时首次拉取；保存后用宿主返回的新值刷新。
 * 「人格」卡里的模板库与会话人格的模板下拉都读这一份 personas。
 */
function usePersonaModelData(getRpc: (() => RpcCaller | undefined) | undefined, active: boolean): PersonaModelData {
	const [status, setStatus] = useState<PersonaModelData['status']>('idle');
	const [failed, setFailed] = useState<string | null>(null);
	const [personas, setPersonas] = useState<PersonaRecordView[]>([]);
	const [libraryDefault, setLibraryDefault] = useState('');
	const [rows, setRows] = useState<RouteRowView[]>([]);
	const [defaultRow, setDefaultRow] = useState<DefaultRowView>({});
	const [models, setModels] = useState<ModelOptionView[]>([]);
	const [chats, setChats] = useState<ChatOptionView[]>([]);
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
				setFailed(firstError.error?.message ?? '操作失败');
				return;
			}
			setPersonas(parsePersonaList(personasAnswer.value));
			const routes = parseRouteViews(routesAnswer.value);
			setRows(routes.rows);
			setDefaultRow(routes.defaultRow);
			setLibraryDefault(routes.libraryDefault);
			setChats(routes.chats);
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
			const error = answer.error?.message ?? '操作失败';
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
				const error = answer.error?.message ?? '操作失败';
				setFailed(error);
				return { ok: false, error };
			}
			const routes = parseRouteViews(answer.value);
			setRows(routes.rows);
			setDefaultRow(routes.defaultRow);
			setLibraryDefault(routes.libraryDefault);
			setChats(routes.chats);
			setFailed(null);
			return { ok: true };
		},
		[getRpc],
	);

	return { status, failed, personas, libraryDefault, rows, defaultRow, models, chats, reload, savePersonas, saveRows };
}

/**
 * 模型清单（宿主 `models/list`）：与「会话模型设置」的模型列同源，供 settings
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

/** 模板库子分节（「人格」卡内、会话人格之后）。默认人格不在这里选（见「会话模型设置」的默认会话行）。 */
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
	if ((row.model ?? '') !== '') out.model = row.model;
	if ((row.effort ?? '') !== '') out.effort = row.effort;
	return out;
}

/** 「默认会话」行 → 可比较的规范形（不参与号码校验）。 */
function normalizeDefaultRow(row: DefaultRowView): DefaultRowView {
	const out: DefaultRowView = {};
	if ((row.model ?? '') !== '') out.model = row.model;
	if ((row.effort ?? '') !== '') out.effort = row.effort;
	return out;
}

/** 草稿行：`manual` 只是界面态（下拉 ↔ 手填切换），不落盘、不参与脏检查。 */
interface RouteDraftRow extends RouteRowView {
	manual?: boolean;
}

/**
 * 「会话模型设置」表格面板：第一行固定「默认会话」，其余每行左选会话、
 * 中选模型、右选思考强度。人格不在这一列——每个会话的人格是「人格」卡里的
 * SOUL.md，这里只管模型与推理强度。
 *
 * 会话从下拉里选（群名 / 好友备注 + 号码，见宿主 persona/chatList.ts），
 * 不再要求用户手抄号码；清单里没有的会话仍可切到「手动输入」。
 */
function RoutePanel(props: { t: Translate; data: PersonaModelData; disabled: boolean }): ReactNode {
	const { t, data, disabled } = props;
	const [draft, setDraft] = useState<RouteDraftRow[]>([]);
	const [defaultDraft, setDefaultDraft] = useState<DefaultRowView>({});
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);

	useEffect(() => {
		setDraft(data.rows.map((row) => ({ ...row })));
		setDefaultDraft({ ...data.defaultRow });
	}, [data.rows, data.defaultRow]);

	const hasContent = (row: RouteRowView): boolean => row.chat.trim() !== '' || (row.model ?? '') !== '' || (row.effort ?? '') !== '';
	const badChat = draft.some((row) => hasContent(row) && parseChatSelector(row.chat) === null);
	const missingChat = draft.some((row) => row.chat.trim() === '' && ((row.model ?? '') !== '' || (row.effort ?? '') !== ''));
	const keys = draft
		.map((row) => row.chat.trim())
		.filter((chat) => chat !== '')
		.map((chat) => parseChatSelector(chat)?.key ?? chat);
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

	const patch = (index: number, next: Partial<RouteDraftRow>): void => {
		setDraft((prev) => prev.map((row, at) => (at === index ? { ...row, ...next } : row)));
	};

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

	/** 会话下拉：群 / 好友分两组，名字在前号码在后（没有名字时显示原始选择器）。 */
	const knownChats = new Set(data.chats.map((option) => option.chat));
	const groupOptions = data.chats.filter((option) => option.kind === 'group');
	const privateOptions = data.chats.filter((option) => option.kind === 'private');
	const chatOptions = (options: readonly ChatOptionView[]): ReactNode =>
		options.map((option) => (
			<option key={option.chat} value={option.chat}>
				{chatOptionText(option)}
			</option>
		));

	/** 某行模型可选的思考强度；模型留空 = 跟随部署默认模型。 */
	const effortsOf = (model: string): ModelEffortView[] => {
		const match = model !== '' ? data.models.find((entry) => entry.spec === model) : data.models.find((entry) => entry.isDefault === true);
		return match?.efforts ?? [];
	};
	const modelOptionsOf = (value: string): ModelOptionView[] =>
		value !== '' && !data.models.some((entry) => entry.spec === value)
			? [{ spec: value, provider: '', model: '', name: value, efforts: [] }, ...data.models]
			: data.models;
	/** 已保存但当前模型不再支持的强度仍要回显（否则下拉会静默丢值）。 */
	const effortOptionsOf = (model: string, value: string): ModelEffortView[] => {
		const efforts = effortsOf(model);
		return value !== '' && !efforts.some((entry) => entry.id === value) ? [{ id: value, name: value }, ...efforts] : efforts;
	};
	/** 换模型时清掉不再受支持的强度（留着只会在请求时报错）。 */
	const modelPatch = (row: { model?: string; effort?: string }, model: string): { model: string; effort: string } => {
		const ids = effortsOf(model).map((entry) => entry.id);
		const keep = (row.effort ?? '') !== '' && ids.includes(row.effort ?? '');
		return { model, effort: keep ? (row.effort ?? '') : '' };
	};

	const effortSelect = (model: string, effort: string, onChange: (value: string) => void): ReactNode => {
		const options = effortOptionsOf(model, effort);
		return (
			<select
				className={cls(css.input, css.select)}
				value={effort}
				disabled={disabled || saving || options.length === 0}
				aria-label={t('routeColEffort')}
				onChange={(event) => onChange(event.target.value)}
			>
				<option value="">{options.length === 0 ? t('routeEffortUnsupported') : t('routeEffortDefault')}</option>
				{options.map((entry) => (
					<option key={entry.id} value={entry.id}>
						{entry.name}
					</option>
				))}
			</select>
		);
	};

	const defaultModel = defaultDraft.model ?? '';

	return (
		<div className={css.editor}>
			{/* 窄列宽下每行两行：上行会话号码（或「默认会话」标签），下行模型 + 思考强度。 */}
			<div className={css.routeRowDefault}>
				<div className={css.routeLine}>
					<span className={css.routeDefaultLabel}>{t('routeDefaultChat')}</span>
				</div>
				<div className={css.routeLine}>
					<select
						className={cls(css.input, css.select)}
						aria-label={t('routeColModel')}
						value={defaultModel}
						disabled={disabled || saving}
						onChange={(event) => {
							const model = event.target.value;
							setDefaultDraft((prev) => ({ ...prev, ...modelPatch(prev, model) }));
						}}
					>
						<option value="">{t('routeModelDefault')}</option>
						{modelOptionsOf(defaultModel).map((option) => (
							<option key={option.spec} value={option.spec}>
								{modelOptionText(option)}
							</option>
						))}
					</select>
					<span className={css.routeFieldLabel}>{t('routeColEffort')}</span>
					{effortSelect(defaultModel, defaultDraft.effort ?? '', (value) => {
						setDefaultDraft((prev) => ({ ...prev, effort: value }));
					})}
				</div>
			</div>
			{draft.length === 0 ? <p className={css.hint}>{t('routeEmpty')}</p> : null}
			{draft.map((row, index) => {
				const modelValue = row.model ?? '';
				const picker = chatFieldMode(row, knownChats) === 'picker';
				return (
					<div className={css.routeRow} key={index}>
						<div className={css.routeLine}>
							{picker ? (
								<select
									className={cls(css.input, css.select, css.routeChat)}
									value={knownChats.has(row.chat.trim()) ? row.chat.trim() : ''}
									aria-label={t('routeColChat')}
									disabled={disabled || saving}
									onChange={(event) => {
										const value = event.target.value;
										if (value === MANUAL_CHAT_OPTION) patch(index, { manual: true });
										else patch(index, { chat: value, manual: false });
									}}
								>
									<option value="">{t('routeChatPick')}</option>
									{groupOptions.length > 0 ? <optgroup label={t('routeChatGroups')}>{chatOptions(groupOptions)}</optgroup> : null}
									{privateOptions.length > 0 ? <optgroup label={t('routeChatFriends')}>{chatOptions(privateOptions)}</optgroup> : null}
									<option value={MANUAL_CHAT_OPTION}>{t('routeChatManual')}</option>
								</select>
							) : (
								<>
									<input
										className={parseChatSelector(row.chat) === null && row.chat.trim() !== '' ? cls(css.input, css.inputInvalid) : css.input}
										type="text"
										value={row.chat}
										placeholder={t('routeChatPlaceholder')}
										aria-label={t('routeColChat')}
										disabled={disabled || saving}
										onChange={(event) => {
											patch(index, { chat: event.target.value });
										}}
									/>
									{knownChats.size > 0 ? (
										<button
											type="button"
											className={css.reset}
											disabled={disabled || saving}
											onClick={() => {
												// 回到下拉：已填的值不在清单里就清空，避免留下看不见的号码。
												patch(index, { manual: false, chat: knownChats.has(row.chat.trim()) ? row.chat.trim() : '' });
											}}
										>
											{t('routeChatFromList')}
										</button>
									) : null}
								</>
							)}
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
						<div className={css.routeLine}>
							<select
								className={cls(css.input, css.select)}
								aria-label={t('routeColModel')}
								value={modelValue}
								disabled={disabled || saving}
								onChange={(event) => {
									const model = event.target.value;
									patch(index, modelPatch(row, model));
								}}
							>
								<option value="">{t('routeModelDefault')}</option>
								{modelOptionsOf(modelValue).map((option) => (
									<option key={option.spec} value={option.spec}>
										{modelOptionText(option)}
									</option>
								))}
							</select>
							<span className={css.routeFieldLabel}>{t('routeColEffort')}</span>
							{effortSelect(modelValue, row.effort ?? '', (value) => {
								patch(index, { effort: value });
							})}
						</div>
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

/** SOUL.md 列表项（宿主 souls/list）。 */
interface SoulListView {
	chat: string;
	path: string;
	exists: boolean;
	source: string;
	chars: number;
	preview: string;
	template: string;
}

function parseSoulList(value: unknown): SoulListView[] {
	const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const raw = Array.isArray(record.souls) ? record.souls : [];
	const list: SoulListView[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		if (typeof row.chat !== 'string' || row.chat === '') continue;
		list.push({
			chat: row.chat,
			path: typeof row.path === 'string' ? row.path : '',
			exists: row.exists === true,
			source: typeof row.source === 'string' ? row.source : 'template',
			chars: typeof row.chars === 'number' ? row.chars : 0,
			preview: typeof row.preview === 'string' ? row.preview : '',
			template: typeof row.template === 'string' ? row.template : '',
		});
	}
	return list;
}

/**
 * 「会话人格」子分节：每个会话一份 SOUL.md 的查看/编辑/重置/套模板。
 * 模板清单由「人格」卡统一提供（与模板库同源，保存模板后下拉即时更新）；
 * 这里改的是文件本身，保存后重建桥，下一条消息生效。
 */
function SoulPanel(props: {
	t: Translate;
	getRpc: (() => RpcCaller | undefined) | undefined;
	disabled: boolean;
	/** 可套用的模板名（personas/list，与模板库子分节同一份数据）。 */
	templates: readonly string[];
}): ReactNode {
	const { t, getRpc, disabled } = props;
	const [souls, setSouls] = useState<SoulListView[]>([]);
	const [chat, setChat] = useState('');
	const [content, setContent] = useState('');
	const [info, setInfo] = useState<{ path: string; source: string; exists: boolean; chars: number; template: string; error: string | null } | null>(null);
	const [template, setTemplate] = useState('');
	const [defaultTemplate, setDefaultTemplate] = useState('');
	const [libraryDefault, setLibraryDefault] = useState('');
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const call = useCallback(
		async (endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
			const rpc = getRpc?.();
			if (rpc === undefined) {
				setFailed(t('soulRpcUnavailable'));
				return null;
			}
			const answer = await rpc(endpoint, payload);
			if (!answer.ok) {
				setFailed(answer.error?.message ?? '操作失败');
				return null;
			}
			setFailed(null);
			return answer.value !== null && typeof answer.value === 'object' ? (answer.value as Record<string, unknown>) : {};
		},
		[getRpc, t],
	);

	const read = useCallback(
		async (target: string): Promise<void> => {
			if (target === '') return;
			setBusy(true);
			const value = await call('souls/read', { chat: target });
			setBusy(false);
			if (value === null) return;
			setChat(target);
			setContent(typeof value.content === 'string' ? value.content : '');
			setInfo({
				path: typeof value.path === 'string' ? value.path : '',
				source: typeof value.source === 'string' ? value.source : 'template',
				exists: value.exists === true,
				chars: typeof value.chars === 'number' ? value.chars : 0,
				template: typeof value.template === 'string' ? value.template : '',
				error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
			});
			setSaved(false);
		},
		[call],
	);

	const load = useCallback(async (): Promise<void> => {
		setBusy(true);
		const listValue = await call('souls/list', {});
		setBusy(false);
		if (listValue === null) return;
		const list = parseSoulList(listValue);
		setSouls(list);
		// 新会话播种用的默认模板（人格库默认是它的回落值）。
		setDefaultTemplate(typeof listValue.defaultTemplate === 'string' ? listValue.defaultTemplate : '');
		setLibraryDefault(typeof listValue.libraryDefault === 'string' ? listValue.libraryDefault : '');
		if (list.length > 0) await read(list[0]!.chat);
	}, [call, read]);

	/** 改「新会话默认模板」：只影响以后新建的 SOUL.md，不重建现有会话。 */
	const saveDefaultTemplate = async (name: string): Promise<void> => {
		if (disabled || busy) return;
		setBusy(true);
		const value = await call('personas/default', { name });
		setBusy(false);
		if (value === null) return;
		setDefaultTemplate(typeof value.defaultTemplate === 'string' ? value.defaultTemplate : '');
		setLibraryDefault(typeof value.libraryDefault === 'string' ? value.libraryDefault : '');
	};

	useEffect(() => {
		void load();
		// 只在首次挂载时拉一次；后续保存走各自端点刷新。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 模板名来自「人格」卡（personas/list 同源），保存模板后下拉即时更新；
	// 当前选中的模板被改名/删除时回退到第一个，避免下拉停在空值上。
	useEffect(() => {
		setTemplate((prev) => (prev !== '' && props.templates.includes(prev) ? prev : props.templates[0] ?? ''));
	}, [props.templates]);

	const save = async (): Promise<void> => {
		if (chat === '' || disabled || busy) return;
		setBusy(true);
		const value = await call('souls/save', { chat, content });
		setBusy(false);
		if (value !== null) {
			await read(chat);
			setSaved(true);
		}
	};

	const reset = async (): Promise<void> => {
		if (chat === '' || disabled || busy) return;
		setBusy(true);
		const value = await call('souls/reset', { chat });
		setBusy(false);
		if (value !== null) await read(chat);
	};

	const applyTemplate = async (): Promise<void> => {
		if (chat === '' || template === '' || disabled || busy) return;
		setBusy(true);
		const value = await call('souls/apply', { chat, persona: template });
		setBusy(false);
		if (value !== null) await read(chat);
	};

	const sourceLabel = (source: string): string => {
		if (source === 'file') return t('soulSourceFile');
		if (source === 'seeded') return t('soulSourceSeeded');
		if (source === 'empty') return t('soulSourceEmpty');
		return t('soulSourceTemplate');
	};

	if (souls.length === 0) {
		return (
			<div className={css.logPanel}>
				{failed !== null ? <p className={css.failed} role="status">{failed}</p> : null}
				<p className={css.hint}>{busy ? t('loading') : t('soulNoChats')}</p>
			</div>
		);
	}

	const defaultOptions = defaultTemplate !== '' && !props.templates.includes(defaultTemplate) ? [defaultTemplate, ...props.templates] : props.templates;

	return (
		<div className={css.editor}>
			<div className={css.chipAdd}>
				<span className={css.chipRowLabel}>{t('soulDefaultTemplate')}</span>
				<select
					className={cls(css.input, css.select)}
					value={defaultTemplate}
					disabled={disabled || busy}
					aria-label={t('soulDefaultTemplate')}
					onChange={(event) => void saveDefaultTemplate(event.target.value)}
				>
					<option value="">{t('soulDefaultTemplateLibrary').replace('{name}', libraryDefault)}</option>
					{defaultOptions.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
			</div>
			<p className={css.hint}>{t('soulDefaultTemplateHint')}</p>
			<div className={css.taskHead}>
				<select className={cls(css.input, css.select)} value={chat} disabled={disabled || busy} onChange={(event) => void read(event.target.value)}>
					{souls.map((item) => (
						<option key={item.chat} value={item.chat}>
							{item.chat}（{item.chars} 字）
						</option>
					))}
				</select>
			</div>
			{info !== null ? (
				<p className={css.hint}>
					{info.path} · {sourceLabel(info.source)} · {info.chars} 字 · {t('soulTemplateHint').replace('{name}', info.template || '—')}
				</p>
			) : null}
			{info?.error !== null && info?.error !== undefined ? <p className={css.failed}>{info.error}</p> : null}
			{/* 必须带 textarea 类：.dshqq-input 固定 height:34px，会把 rows 压成一行。 */}
			<textarea className={cls(css.input, css.textarea)} rows={10} value={content} disabled={disabled || busy} onChange={(event) => setContent(event.target.value)} />
			{/* 套模板是另一个动作组，单独一行；保存/恢复留在 footer，窄列宽下不会被挤成竖排。 */}
			<div className={css.chipAdd}>
				<select className={cls(css.input, css.select)} value={template} disabled={disabled || busy} onChange={(event) => setTemplate(event.target.value)}>
					{props.templates.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
				<button type="button" className={css.discard} disabled={disabled || busy || template === ''} onClick={() => void applyTemplate()}>
					{t('soulApplyTemplate')}
				</button>
			</div>
			<div className={css.footer}>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void reset()}>
					{t('soulReset')}
				</button>
				<button type="button" className={css.save} disabled={disabled || busy} onClick={() => void save()}>
					{t('soulSave')}
				</button>
			</div>
			{saved ? <p className={css.saved} role="status">{t('soulSaved')}</p> : null}
			{failed !== null ? <p className={css.failed} role="status">{failed}</p> : null}
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
	delivery: TaskDelivery;
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
			delivery: normalizeTaskDelivery(entry.delivery),
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
				setFailed(answer.error?.message ?? '操作失败');
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
				const error = answer.error?.message ?? '操作失败';
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

/** 记忆/技能面板的视图类型（宿主 RPC 返回）。 */
interface RagProgressView {
	kind: string;
	message?: string;
	file?: string;
	model?: string;
	percent?: number;
	loaded?: number;
	total?: number;
}

interface RagModelStatusView {
	id: string;
	download: string;
	load: string;
	error?: string;
}

interface RagStatusView {
	ready: boolean;
	db: boolean;
	fts: boolean;
	vec: boolean;
	embed: boolean;
	rerank: boolean;
	runtime: string;
	model: string;
	models?: { embedding: RagModelStatusView; reranker: RagModelStatusView };
	messages: number;
	chunks: number;
	skills: number;
	lastError?: string;
	progress?: RagProgressView;
}

interface RagChunkView {
	id: number;
	ts: number;
	text: string;
	score: number;
}

interface RagSkillView {
	id: number;
	name: string;
	description: string;
	whenToUse: string;
	body: string;
	status: string;
	scope: string;
	useCount: number;
}

function parseRagProgress(value: unknown): RagProgressView | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.kind !== 'string') return undefined;
	return {
		kind: row.kind,
		...(typeof row.message === 'string' ? { message: row.message } : {}),
		...(typeof row.file === 'string' ? { file: row.file } : {}),
		...(row.model === 'embedding' || row.model === 'reranker' ? { model: row.model } : {}),
		...(typeof row.percent === 'number' && Number.isFinite(row.percent) ? { percent: row.percent } : {}),
		...(typeof row.loaded === 'number' && Number.isFinite(row.loaded) ? { loaded: row.loaded } : {}),
		...(typeof row.total === 'number' && Number.isFinite(row.total) ? { total: row.total } : {}),
	};
}

function parseRagModelStatus(value: unknown, fallbackId: string): RagModelStatusView | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const row = value as Record<string, unknown>;
	return {
		id: typeof row.id === 'string' ? row.id : fallbackId,
		download: typeof row.download === 'string' ? row.download : 'unknown',
		load: typeof row.load === 'string' ? row.load : 'unknown',
		...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
	};
}

function legacyModelStatus(model: string, enabled: boolean, id: string): RagModelStatusView {
	if (!enabled) return { id, download: 'disabled', load: 'disabled' };
	if (model === 'ready') return { id, download: 'ready', load: 'ready' };
	if (model === 'downloading') return { id, download: 'downloading', load: 'loading' };
	if (model === 'error') return { id, download: 'error', load: 'error' };
	return { id, download: 'missing', load: 'missing' };
}

function parseRagStatus(value: unknown): RagStatusView | null {
	const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	if (typeof record.ready !== 'boolean') return null;
	const embed = record.embed === true;
	const rerank = record.rerank === true;
	const modelsRaw = record.models !== null && typeof record.models === 'object' ? (record.models as Record<string, unknown>) : {};
	const embedding = parseRagModelStatus(modelsRaw.embedding, 'embedding') ?? legacyModelStatus(
		typeof record.model === 'string' ? record.model : 'unknown',
		true,
		'embedding',
	);
	const reranker = parseRagModelStatus(modelsRaw.reranker, 'reranker') ?? legacyModelStatus(
		rerank ? 'ready' : 'missing',
		true,
		'reranker',
	);
	return {
		ready: record.ready,
		db: record.db === true,
		fts: record.fts === true,
		vec: record.vec === true,
		embed,
		rerank,
		runtime: typeof record.runtime === 'string' ? record.runtime : 'unknown',
		model: typeof record.model === 'string' ? record.model : 'unknown',
		models: { embedding, reranker },
		messages: typeof record.messages === 'number' ? record.messages : 0,
		chunks: typeof record.chunks === 'number' ? record.chunks : 0,
		skills: typeof record.skills === 'number' ? record.skills : 0,
		...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
		...(parseRagProgress(record.progress) !== undefined ? { progress: parseRagProgress(record.progress)! } : {}),
	};
}

function parseChunks(value: unknown): RagChunkView[] {
	const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const raw = Array.isArray(record.items) ? record.items : [];
	const items: RagChunkView[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		if (typeof row.id !== 'number' || typeof row.text !== 'string') continue;
		items.push({
			id: row.id,
			ts: typeof row.ts === 'number' ? row.ts : 0,
			text: row.text,
			score: typeof row.score === 'number' ? row.score : 0,
		});
	}
	return items;
}

function parseSkills(value: unknown): RagSkillView[] {
	const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const raw = Array.isArray(record.items) ? record.items : [];
	const items: RagSkillView[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		if (typeof row.id !== 'number' || typeof row.name !== 'string') continue;
		items.push({
			id: row.id,
			name: row.name,
			description: typeof row.description === 'string' ? row.description : '',
			whenToUse: typeof row.whenToUse === 'string' ? row.whenToUse : '',
			body: typeof row.body === 'string' ? row.body : '',
			status: typeof row.status === 'string' ? row.status : 'active',
			scope: row.scope === 'global' ? 'global' : 'chat',
			useCount: typeof row.useCount === 'number' ? row.useCount : 0,
		});
	}
	return items;
}

function formatBytes(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return '';
	if (value < 1024) return `${Math.round(value)} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatChunkTime(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return '';
	const date = new Date(ts);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 记忆状态轮询：配置卡与记忆库共用，1.5s 只在对应面板可见时运行。 */
function useMemoryStatus(
	getRpc: (() => RpcCaller | undefined) | undefined,
	enabled: boolean,
): [RagStatusView | null, (status: RagStatusView | null) => void] {
	const [status, setStatus] = useState<RagStatusView | null>(null);
	useEffect(() => {
		if (!enabled || getRpc === undefined) return;
		let cancelled = false;
		const tick = async (): Promise<void> => {
			const call = getRpc();
			if (call === undefined) return;
			try {
				const answer = await call('memory/status', {});
				if (cancelled || !answer.ok) return;
				setStatus(parseRagStatus(answer.value));
			} catch {
				// 短暂失败不打断面板；下一次轮询会恢复。
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), 1500);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [enabled, getRpc]);
	return [status, setStatus];
}

function modelStateLabel(t: Translate, kind: 'download' | 'load' | 'runtime', value: string): string {
	const base = kind === 'download' ? 'memoryStateDownload' : kind === 'load' ? 'memoryStateLoad' : 'memoryStateRuntime';
	const suffix =
		value === 'ready'
			? 'Ready'
			: value === 'downloading' || value === 'loading' || value === 'installing'
				? 'Busy'
				: value === 'error'
					? 'Error'
					: value === 'disabled'
						? 'Disabled'
						: 'Missing';
	return t(`${base}${suffix}`);
}

function modelStateClass(value: string): string {
	if (value === 'ready') return css.modelStateOk;
	if (value === 'downloading' || value === 'loading' || value === 'installing') return css.modelStateBusy;
	if (value === 'error') return css.modelStateError;
	return css.modelStateOff;
}

function ModelStatusCard(props: {
	t: Translate;
	title: string;
	status: RagModelStatusView;
	progress?: RagProgressView;
	onDownload?: () => Promise<void> | void;
}): ReactNode {
	const { t, title, status, progress, onDownload } = props;
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	const downloading = status.download === 'downloading' || status.load === 'loading';
	const installed = status.download === 'ready' && status.load === 'ready';
	const broken = status.download === 'error' || status.load === 'error';
	const percent = progress?.percent;
	const start = useCallback((): void => {
		if (onDownload === undefined || pending) return;
		setPending(true);
		setFailed(null);
		void Promise.resolve(onDownload())
			.catch((error: unknown) => {
				setFailed(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				setPending(false);
			});
	}, [onDownload, pending]);
	const busy = downloading || pending;
	let action: ReactNode;
	if (busy) {
		// 用户明确要求：下载中把按钮换成进度条（拿不到百分比时走不确定态动画）。
		action = (
			<span className={css.modelProgress}>
				<span className={css.modelBar}>
					<span
						className={cls(css.modelBarFill, percent === undefined ? css.modelBarFillBusy : undefined)}
						style={percent === undefined ? undefined : { width: `${Math.max(2, Math.min(100, percent))}%` }}
					/>
				</span>
				<span className={css.modelPercent}>{percent === undefined ? null : `${Math.round(percent)}%`}</span>
			</span>
		);
	} else if (installed) {
		action = <span className={css.modelInstalled}>{t('memoryModelInstalled')}</span>;
	} else if (status.download === 'disabled') {
		action = <span className={cls(css.modelState, css.modelStateOff)}>{t('memoryStateDownloadDisabled')}</span>;
	} else {
		action = (
			<button type="button" className={css.discard} disabled={onDownload === undefined} onClick={start}>
				{broken ? t('memoryModelRetry') : t('memoryModelDownload')}
			</button>
		);
	}
	return (
		<div className={css.modelCard}>
			<div className={css.modelTitle}>
				<span>{title}</span>
				<span className={css.modelAction}>{action}</span>
			</div>
			<p className={css.modelName} title={status.id}>
				{status.id === '' ? '—' : status.id}
			</p>
			{failed !== null ? <p className={css.failed}>{failed}</p> : null}
			{broken && status.error !== undefined ? <p className={css.failed}>{status.error}</p> : null}
		</div>
	);
}

/**
 * 本地模型状态：两个模型各一张卡，卡片右侧就是操作区——
 * 未下载显示「下载」，下载中显示进度条，就绪显示「已安装」。
 * 状态来自 worker 的真实加载流程（模型 id 另起一行显示）。
 */
function MemoryModelStatusPanel(props: {
	t: Translate;
	status: RagStatusView | null;
	onDownload?: (model: 'embedding' | 'reranker') => Promise<void> | void;
}): ReactNode {
	const { t, status } = props;
	if (status === null) return <p className={css.hint}>{t('loading')}</p>;
	const models = status.models ?? {
		embedding: legacyModelStatus(status.model, true, 'embedding'),
		reranker: legacyModelStatus(status.rerank ? 'ready' : 'missing', true, 'reranker'),
	};
	const progressOf = (kind: 'embedding' | 'reranker'): RagProgressView | undefined =>
		status.progress?.model === kind || (status.progress?.model === undefined && kind === 'embedding') ? status.progress : undefined;
	const runtime =
		models.embedding.download === 'disabled' && models.reranker.download === 'disabled'
			? 'disabled'
			: status.progress?.kind === 'install'
				? 'installing'
				: status.runtime;
	return (
		<div className={css.modelGrid}>
			<div className={css.modelGridHead}>
				<span className={css.label}>{t('memoryModelStatus')}</span>
				<span className={cls(css.modelState, modelStateClass(runtime))}>
					{modelStateLabel(t, 'runtime', runtime)}
					{runtime === 'installing' && status.progress?.percent !== undefined
						? ` ${Math.round(status.progress.percent)}%`
						: ''}
				</span>
			</div>
			<ModelStatusCard
				t={t}
				title={t('memoryEmbeddingModelShort')}
				status={models.embedding}
				progress={progressOf('embedding')}
				onDownload={props.onDownload === undefined ? undefined : () => props.onDownload?.('embedding')}
			/>
			<ModelStatusCard
				t={t}
				title={t('memoryRerankModelShort')}
				status={models.reranker}
				progress={progressOf('reranker')}
				onDownload={props.onDownload === undefined ? undefined : () => props.onDownload?.('reranker')}
			/>
			{status.lastError !== undefined ? <p className={css.failed}>{status.lastError}</p> : null}
		</div>
	);
}

/**
 * 记忆库与技能面板：状态、检索测试、最近片段、运行时安装、技能管理。
 * 配置项仍在上一张「长期记忆」卡。
 */
function MemoryPanel(props: { t: Translate; getRpc: (() => RpcCaller | undefined) | undefined; disabled: boolean }): ReactNode {
	const { t, getRpc, disabled } = props;
	const [chatKey, setChatKey] = useState('');
	const [query, setQuery] = useState('');
	const [status, setStatus] = useMemoryStatus(getRpc, true);
	const [chunks, setChunks] = useState<RagChunkView[]>([]);
	const [skills, setSkills] = useState<RagSkillView[]>([]);
	const [selected, setSelected] = useState<RagSkillView | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);

	const call = useCallback(async (endpoint: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
		const rpc = getRpc?.();
		if (rpc === undefined) throw new Error(t('memoryRpcUnavailable'));
		const result = await rpc(endpoint, payload);
		if (!result.ok) throw new Error(result.error?.message ?? 'RPC 失败');
		return result.value;
	}, [getRpc, t]);

	const run = useCallback(async (task: () => Promise<void>): Promise<void> => {
		if (disabled) return;
		setBusy(true);
		setFailed(null);
		try {
			await task();
		} catch (error) {
			setFailed(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}, [disabled]);

	const refreshStatus = useCallback(async (): Promise<void> => {
		await run(async () => {
			setStatus(parseRagStatus(await call('memory/status')));
		});
	}, [call, run]);

	const search = useCallback(async (): Promise<void> => {
		await run(async () => {
			if (chatKey.trim() === '' || query.trim() === '') throw new Error(t('memoryChatRequired'));
			const value = (await call('memory/search', { chatKey: chatKey.trim(), query: query.trim(), limit: 10 })) as { items?: unknown };
			setChunks(parseChunks(value));
		});
	}, [call, chatKey, query, run, t]);

	const loadRecent = useCallback(async (): Promise<void> => {
		await run(async () => {
			if (chatKey.trim() === '') throw new Error(t('memoryChatRequired'));
			const value = (await call('memory/recent', { chatKey: chatKey.trim(), limit: 20 })) as { items?: unknown };
			setChunks(parseChunks(value));
		});
	}, [call, chatKey, run, t]);

	const loadSkills = useCallback(async (): Promise<void> => {
		await run(async () => {
			if (chatKey.trim() === '') throw new Error(t('memoryChatRequired'));
			const value = (await call('skills/list', { chatKey: chatKey.trim(), includeInactive: true })) as { items?: unknown };
			setSkills(parseSkills(value));
		});
	}, [call, chatKey, run, t]);

	const setup = useCallback(async (): Promise<void> => {
		await run(async () => {
			await call('memory/setup');
			setStatus(parseRagStatus(await call('memory/status')));
		});
	}, [call, run]);

	const reindex = useCallback(async (): Promise<void> => {
		await run(async () => {
			if (chatKey.trim() === '') throw new Error(t('memoryChatRequired'));
			await call('memory/reindex', { chatKey: chatKey.trim() });
			await refreshStatus();
		});
	}, [call, chatKey, refreshStatus, run, t]);

	const prune = useCallback(async (): Promise<void> => {
		await run(async () => {
			await call('memory/prune');
			await refreshStatus();
		});
	}, [call, refreshStatus, run]);

	const deleteChunk = useCallback(async (id: number): Promise<void> => {
		await run(async () => {
			await call('memory/delete', { id });
			setChunks((prev) => prev.filter((item) => item.id !== id));
		});
	}, [call, run]);

	const toggleSkill = useCallback(async (skill: RagSkillView): Promise<void> => {
		await run(async () => {
			await call('skills/toggle', { id: skill.id, status: skill.status === 'active' ? 'disabled' : 'active' });
			await loadSkills();
		});
	}, [call, loadSkills, run]);

	const deleteSkill = useCallback(async (skill: RagSkillView): Promise<void> => {
		await run(async () => {
			await call('skills/delete', { chatKey: chatKey.trim(), id: skill.id });
			await loadSkills();
		});
	}, [call, chatKey, loadSkills, run]);

	const promoteSkill = useCallback(async (skill: RagSkillView): Promise<void> => {
		await run(async () => {
			await call('skills/promote', { chatKey: chatKey.trim(), id: skill.id });
			await loadSkills();
		});
	}, [call, chatKey, loadSkills, run]);

	return (
		<div className={css.logPanel}>
			<div className={css.taskHead}>
				<input
					className={css.input}
					type="text"
					value={chatKey}
					placeholder={t('memoryChatPlaceholder')}
					disabled={disabled || busy}
					onChange={(event) => setChatKey(event.target.value)}
				/>
				<input
					className={css.input}
					type="text"
					value={query}
					placeholder={t('memorySearchPlaceholder')}
					disabled={disabled || busy}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			<div className={css.footer}>
				<button type="button" className={css.save} disabled={disabled || busy} onClick={() => void refreshStatus()}>
					{t('memoryStatus')}
				</button>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void search()}>
					{t('memoryPreview')}
				</button>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void loadRecent()}>
					{t('memoryRecent')}
				</button>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void loadSkills()}>
					{t('memorySkills')}
				</button>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void setup()}>
					{t('memorySetup')}
				</button>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void reindex()}>
					{t('memoryReindex')}
				</button>
				<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void prune()}>
					{t('memoryPrune')}
				</button>
			</div>
			{failed !== null ? (
				<p className={css.failed} role="status">
					{failed}
				</p>
			) : null}
			{status?.progress !== undefined ? (
				<div className={css.progressWrap}>
					<p className={css.hint}>
						{status.progress.kind === 'install' ? t('memoryInstallingRuntime') : t('memoryDownloading')}
						{status.progress.percent !== undefined ? ` ${Math.round(status.progress.percent)}%` : ''}
						{status.progress.file !== undefined ? ` ｜ ${status.progress.file}` : ''}
					</p>
					<div className={css.progressTrack}>
						<div
							className={cls(css.progressBar, status.progress.percent === undefined ? css.progressIndeterminate : undefined)}
							style={status.progress.percent !== undefined ? { width: `${Math.max(2, Math.min(100, status.progress.percent))}%` } : undefined}
						/>
					</div>
					{status.progress.loaded !== undefined || status.progress.total !== undefined ? (
						<p className={css.hint}>
							{formatBytes(status.progress.loaded)}
							{status.progress.total !== undefined ? ` / ${formatBytes(status.progress.total)}` : ''}
						</p>
					) : null}
				</div>
			) : null}
			{status !== null ? (
				<div className={css.logPanel}>
					<MemoryModelStatusPanel
						t={t}
						status={status}
						onDownload={async (model) => {
							await call('memory/models/download', { model });
							setStatus(parseRagStatus(await call('memory/status')));
						}}
					/>
					<p className={css.hint}>
						消息 {status.messages} ｜ 片段 {status.chunks} ｜ 技能 {status.skills} ｜ DB={status.db ? '✓' : '✗'} ｜ FTS={status.fts ? '✓' : '✗'} ｜ vec={status.vec ? '✓' : '✗'}
					</p>
				</div>
			) : null}
			{chunks.length > 0 ? (
				<div className={css.logPanel}>
					<p className={css.hint}>{t('memoryRecent')}</p>
					{chunks.map((item) => (
						<div key={item.id} className={css.logPanel}>
							<p className={css.hint}>
								#{item.id} ｜ {formatChunkTime(item.ts)} ｜ 分数={item.score.toFixed(3)}
							</p>
							<pre className={css.hint}>{item.text}</pre>
							<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void deleteChunk(item.id)}>
								{t('memoryDelete')}
							</button>
						</div>
					))}
				</div>
			) : null}
			{skills.length > 0 ? (
				<div className={css.logPanel}>
					<p className={css.hint}>{t('memorySkills')}</p>
					{skills.map((skill) => (
						<div key={skill.id} className={css.logPanel}>
							<p className={css.hint}>
								{skill.name}（{skill.scope === 'global' ? 'global' : 'chat'}，{skill.status}，used {skill.useCount}）
							</p>
							<p className={css.hint}>{skill.description}</p>
							<div className={css.footer}>
								<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => setSelected(skill)}>
									{t('memoryView')}
								</button>
								<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void toggleSkill(skill)}>
									{skill.status === 'active' ? t('memoryDisable') : t('memoryEnable')}
								</button>
								<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void promoteSkill(skill)}>
									{t('memoryPromote')}
								</button>
								<button type="button" className={css.discard} disabled={disabled || busy} onClick={() => void deleteSkill(skill)}>
									{t('memoryDelete')}
								</button>
							</div>
						</div>
					))}
				</div>
			) : null}
			{selected !== null ? (
				<div className={css.logPanel}>
					<p className={css.hint}>{selected.name}</p>
					<pre className={css.hint}>{selected.body}</pre>
				</div>
			) : null}
		</div>
	);
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
	delivery: TaskDelivery;
	note: string;
}

function draftOf(view: TaskRecordView): TaskDraft {
	return {
		id: view.id,
		chat: view.chat,
		kind: view.kind,
		time: view.time,
		weekdays: view.weekdays,
		runAt: view.runAt,
		prompt: view.prompt,
		delivery: view.delivery,
		note: view.note,
	};
}

/** epoch ms → 本地 `MM-DD HH:mm`（任务列表展示用）。 */
function formatStamp(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 定时任务面板（卡片展开体）：列表 + 单任务操作（启停/立即执行/编辑/删除），
 * 编辑走暂存草稿（保存才落库）；新建/编辑是同一个表单。与「会话模型设置」
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
		if (draft.delivery === 'direct') {
			const detail = taskTemplateError(draft.prompt);
			if (detail !== null) return t('taskTemplateInvalid').replace('{detail}', detail);
		}
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
			delivery: editing.delivery,
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
			<select
				className={cls(css.input, css.select)}
				aria-label={t('taskDeliveryLabel')}
				value={draft.delivery}
				disabled={disabled || saving}
				onChange={(event) => {
					const delivery = normalizeTaskDelivery(event.target.value);
					setEditing((prev) => (prev === null ? prev : { ...prev, delivery }));
				}}
			>
				<option value="direct">{t('taskDeliveryDirect')}</option>
				<option value="agent">{t('taskDeliveryAgent')}</option>
			</select>
			<p className={css.hint}>{t(draft.delivery === 'direct' ? 'taskDeliveryHintDirect' : 'taskDeliveryHintAgent')}</p>
			<textarea
				className={cls(css.input, css.textarea)}
				value={draft.prompt}
				placeholder={t(draft.delivery === 'direct' ? 'taskPromptPlaceholderDirect' : 'taskPromptPlaceholder')}
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
							setEditing({ chat: '', kind: 'daily', time: '', weekdays: [1, 2, 3, 4, 5], runAt: '', prompt: '', delivery: 'direct', note: '' });
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
							<span className={css.taskSchedule}>
								{describeSchedule(scheduleOf(task))} · {t(task.delivery === 'direct' ? 'taskDeliveryDirectShort' : 'taskDeliveryAgentShort')}
							</span>
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
	 * 与「会话模型设置」卡片的模型列同源（见 useModelOptions）。
	 */
	modelOptions?: readonly ModelOptionView[];
	onEdit: (key: string, text: string) => void;
	onStageValue: (key: string, value: unknown) => void;
	onStageList: (key: string, items: string[]) => void;
	onStageClear: (key: string) => void;
}

/**
 * 头部：只有 label。
 * 用户明确要求去掉逐字段的「恢复默认」入口（连"已覆盖"角标一起）：
 * 想撤销某个字段在 user 层的覆盖，只能改 profile 配置或整卡放弃草稿。
 */
function FieldHead(props: RowProps & { htmlFor: string }): ReactNode {
	const { def, t } = props;
	return (
		<div className={css.head}>
			<label className={css.label} htmlFor={props.htmlFor}>
				{t(`${def.key}Label`)}
			</label>
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
	const hintText = state.invalid ? t('invalidNumber') : t(hintKey);
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
			<p title={hintText} className={state.invalid ? css.invalid : cls(css.hint, css.fieldHint)}>{hintText}</p>
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
			<p title={t(`${def.key}Hint`)} className={cls(css.hint, css.fieldHint)}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/** 模型下拉的选项文案：`名称（provider/model）`；没有别名时只显示规格串。 */
function modelOptionText(option: { spec: string; name: string }): string {
	return option.name === '' || option.name === option.spec ? option.spec : `${option.name}（${option.spec}）`;
}

/**
 * 模型下拉（modelSelect）：与「会话模型设置」卡片的模型列**同一份清单与文案**
 * （宿主 models/list = dsh「设置 → 模型」的运行时清单）。值型是 `provider/model`
 * 规格串，空 = 部署默认模型；一次选择同时写 provider 与 model 两个配置项
 * （见 form.ts 的 planModelWrite）。
 *
 * 清单为空（旧宿主 / llm 服务缺失）时只留「部署默认」一项并给出提示——与
 * 「会话模型设置」的行为一致，不退回文本框（模型 id 无法凭空猜）。
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
			<p title={t(`${def.key}Hint`)} className={cls(css.hint, css.fieldHint)}>{t(`${def.key}Hint`)}</p>
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
				{options.map((option) => {
					const label = toolLabel(t, option);
					return (
						<label key={option} className={css.checkItem}>
							<input
								type="checkbox"
								checked={selected.has(option)}
								disabled={disabled}
								onChange={(event) => {
									toggle(option, event.target.checked);
								}}
							/>
							{/* 中文显示名 + 工具 id：写进配置的是 id，灰字只是让用户能对上文档/手改配置。
							    没有词条的工具（新装的 dsh 插件）只显示 id，不重复渲染。 */}
							<span className={css.checkName}>{label}</span>
							{label !== option ? <span className={css.checkId}>{option}</span> : null}
						</label>
					);
				})}
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
			<p title={t(`${def.key}Hint`)} className={cls(css.hint, css.fieldHint)}>{t(`${def.key}Hint`)}</p>
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
			{/* 列表不是可标注（labelable）控件，所以头部与 SwitchRow 一样自己渲染 label。 */}
			<div className={css.head}>
				<span className={css.label}>{t(`${def.key}Label`)}</span>
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
			<p title={t(`${def.key}Hint`)} className={cls(css.hint, css.fieldHint)}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/** 开关（boolean）。 */
function SwitchRow(props: RowProps): ReactNode {
	const { def, state, t, disabled } = props;
	return (
		<div className={css.field}>
			<div className={css.toggleRow}>
				<span className={css.label}>{t(`${def.key}Label`)}</span>
				<span className={css.badges}>
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
			<p title={t(`${def.key}Hint`)} className={cls(css.hint, css.fieldHint)}>{t(`${def.key}Hint`)}</p>
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
			<p title={t(`${def.key}Hint`)} className={cls(css.hint, css.fieldHint)}>{t(`${def.key}Hint`)}</p>
		</div>
	);
}

/**
 * 只读展示行：值由代码或配置文件决定，界面上能看不能改。
 * 用于和存储格式绑死的参数（embedding 模型 id ↔ 向量表维度），
 * 避免给用户一个"改了会静默坏"的输入框，同时保留可见性。
 * 用户明确要求不显示「只读」角标和解释性说明，所以这里只有 label + 值。
 */
function ReadonlyRow(props: RowProps): ReactNode {
	const { def, state, t } = props;
	return (
		<div className={css.field}>
			<div className={css.head}>
				<span className={css.label}>{t(`${def.key}Label`)}</span>
			</div>
			<code className={css.readonlyValue}>{state.text}</code>
		</div>
	);
}

function FieldRow(props: RowProps): ReactNode {
	switch (props.def.kind) {
		case 'readonly':
			return <ReadonlyRow {...props} />;
		case 'boolean':
			return <SwitchRow {...props} />;
		case 'enum':
		case 'quoteMode':
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
 * 卡内子分节。长配置（尤其长期记忆）默认只展开第一组，其余折叠，避免为了
 * 一个参数滚过几十个控件；保存栏独立吸顶，不随折叠内容移动。
 * 不可折叠形态（collapsible=false）也用于自定义卡片里的功能块
 * （如「人格」卡的〔会话人格〕〔人格模板〕），保持与字段卡片一致的标题样式。
 */
function FieldSubsection(props: {
	title: string;
	count?: number;
	collapsible: boolean;
	defaultOpen: boolean;
	children: ReactNode;
}): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen);
	if (!props.collapsible) {
		return (
			<section className={css.subsection}>
				{props.title !== '' ? <h4 className={css.subHead}>{props.title}</h4> : null}
				<div className={css.subsectionBody}>{props.children}</div>
			</section>
		);
	}
	return (
		<details
			className={css.subsection}
			open={open}
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
			}}
		>
			<summary className={css.subsectionHead}>
				<span>{props.title}</span>
				{props.count !== undefined ? <span className={css.subsectionCount}>{props.count}</span> : null}
				<svg className={cls(css.chevron, open && css.chevronOpen)} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
					<path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</summary>
			<div className={css.subsectionBody}>{props.children}</div>
		</details>
	);
}

/**
 * 单张功能域卡片：导航模式下头部常显，卡内保存栏吸顶；子分节可折叠。
 * 暂存/保存状态由 controller 按卡维护，切换功能域不会丢草稿。
 */
function GroupCard(
	props: CardProps & {
		group: FieldGroup;
		state: CardState;
		open: boolean;
		onOpenChange: (id: string, open: boolean) => void;
		/** 字段之后、保存按钮之前的附加内容（如日志卡片内嵌的日志视图）。 */
		extra?: ReactNode;
		/** 字段之前的只读状态区（如长期记忆的本地模型状态）。 */
		statusBody?: ReactNode;
		/** 导航模式下卡片头不可折叠，功能域切换由左侧导航负责。 */
		staticHeader?: boolean;
		/** 折叠头部的附加角标（如日志条数）。 */
		extraBadge?: ReactNode;
		/** 自定义交互卡片（人格库 / 会话模型设置）的展开体：替代字段列表与保存栏。 */
		customBody?: ReactNode;
		/** 模型下拉（modelSelect）的选项（宿主 models/list）。 */
		modelOptions?: readonly ModelOptionView[];
	},
): ReactNode {
	const { group, state, open, onOpenChange } = props;
	const custom = group.custom !== undefined;
	const shell: CardShell = state.cards[group.id] ?? { dirty: false, invalid: false, saving: false, failed: false, saved: false };
	if (!state.available) return null;
	const disabled = !state.writable || shell.saving;
	const blocked = !shell.dirty || shell.invalid || shell.saving;
	// 卡内子分节：先按 sub 聚成组，长配置可折叠；非记忆卡仍直接铺开，
	// 子标题只承担信息分组，不增加额外点击。
	const subsections: Array<{ sub?: string; rows: ReactNode[] }> = [];
	for (const def of group.fields) {
		const fieldState = state.fields[def.key];
		if (fieldState === undefined) continue;
		const last = subsections[subsections.length - 1];
		const bucket = last !== undefined && last.sub === def.sub ? last : { sub: def.sub, rows: [] };
		if (bucket !== last) subsections.push(bucket);
		bucket.rows.push(
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
				onStageClear={props.stageClear}
			/>,
		);
	}
	const collapsibleSubsections = group.id === 'memory';
	const saveBar = (
		<div className={css.saveBar}>
			{shell.failed ? (
				<p className={css.failed} role="status">
					{props.t('saveFailed')}
				</p>
			) : shell.saved ? (
				<p className={css.saved} role="status">
					{props.t('savedNotice')}
				</p>
			) : (
				<span className={css.hint}>{shell.dirty ? props.t('unsaved') : ''}</span>
			)}
			<span className={css.saveActions}>
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
			</span>
		</div>
	);
	const header = (
		<>
			<span className={css.headText}>
				<span className={css.name}>{props.t(group.titleKey)}</span>
				<span className={css.description} title={props.t(group.descKey)}>{props.t(group.descKey)}</span>
			</span>
			{props.extraBadge}
			{!custom && shell.dirty ? <span className={css.pending}>{props.t('unsaved')}</span> : null}
			{props.staticHeader !== true ? (
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
			) : null}
		</>
	);
	return (
		<li className={cls(css.card, open && css.cardOpen)}>
			{props.staticHeader === true ? (
				<div className={css.header}>{header}</div>
			) : (
				<button
					type="button"
					className={css.header}
					aria-expanded={open}
					aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${props.t(group.titleKey)}`}
					onClick={() => {
						onOpenChange(group.id, !open);
					}}
				>
					{header}
				</button>
			)}
			{open ? (
				<div className={css.body}>
					{custom ? (
						props.customBody
					) : (
						<>
							{saveBar}
							{props.statusBody}
							{subsections.map((bucket, index) => (
								<FieldSubsection
									key={bucket.sub ?? `section:${index}`}
									title={bucket.sub !== undefined ? props.t(bucket.sub) : ''}
									count={bucket.rows.length}
									collapsible={collapsibleSubsections && bucket.sub !== undefined}
									defaultOpen={index === 0}
								>
									{bucket.rows}
								</FieldSubsection>
							))}
							{props.extra}
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
	// 导航选中项跨重挂载保留：保存设置会触发宿主重渲染，不能因此跳回第一页。
	const firstGroupId = FIELD_GROUPS[0]?.id ?? CONNECTION_CARD_ID;
	const [activeGroupId, setActiveGroupId] = useState<string>(() => readActiveCard(firstGroupId));
	const selectGroup = useCallback((id: string): void => {
		writeActiveCard(id);
		setActiveGroupId(id);
	}, []);
	const getRpc = props.getRpc as (() => RpcCaller | undefined) | undefined;
	const rpcAvailable = getRpc !== undefined && getRpc() !== undefined;
	const activeGroup = FIELD_GROUPS.find((group) => group.id === activeGroupId) ?? FIELD_GROUPS[0];
	const activeId = activeGroup?.id ?? firstGroupId;
	const logActive = rpcAvailable && activeGroup?.logViewer === true;
	const log = useMessageLog(getRpc, logActive);
	// 自定义数据只在对应功能域可见时拉取，避免后台轮询无谓 RPC。
	const personaActive = activeGroup?.custom === 'personas' || activeGroup?.custom === 'routes';
	const personaData = usePersonaModelData(getRpc, personaActive);
	// 模板下拉与模板库同源：空名条目在模板库里不落盘，这里同样过滤掉。
	const personaTemplates = useMemo(
		() => personaData.personas.map((entry) => entry.name.trim()).filter((name) => name !== ''),
		[personaData.personas],
	);
	const modelActive = activeGroup?.fields.some((def) => def.kind === 'modelSelect') === true;
	const modelOptions = useModelOptions(getRpc, rpcAvailable && modelActive);
	const tasksActive = activeGroup?.custom === 'tasks';
	const taskData = useTaskData(getRpc, rpcAvailable && tasksActive);
	const memoryConfigActive = activeGroup?.id === 'memory';
	const [memoryStatus, setMemoryStatus] = useMemoryStatus(getRpc, rpcAvailable && memoryConfigActive);
	const transportConnected = useTransportConnected(getRpc);
	if (!state.available || activeGroup === undefined) return null;
	const navigation: Array<{ section: string; groups: FieldGroup[] }> = [];
	for (const group of FIELD_GROUPS) {
		const section = group.sectionKey ?? '';
		const last = navigation[navigation.length - 1];
		if (last !== undefined && last.section === section) last.groups.push(group);
		else navigation.push({ section, groups: [group] });
	}
	const customBody =
		activeGroup.custom === 'personas' ? (
			<div className={css.panelStack}>
				{/* 两个子分节各自保存：SOUL.md（实际生效源）在上，模板库（来源/套用库）在下。 */}
				<FieldSubsection title={props.t('groupSouls')} collapsible={false} defaultOpen>
					<p className={css.hint}>{props.t('groupSoulsDesc')}</p>
					{rpcAvailable ? (
						<SoulPanel t={props.t} getRpc={getRpc} disabled={!state.writable} templates={personaTemplates} />
					) : (
						<p className={css.hint}>{props.t('soulRpcUnavailable')}</p>
					)}
				</FieldSubsection>
				<FieldSubsection title={props.t('groupPersonas')} collapsible={false} defaultOpen>
					<p className={css.hint}>{props.t('groupPersonasDesc')}</p>
					<PersonaPanel t={props.t} data={personaData} disabled={!state.writable} />
				</FieldSubsection>
			</div>
		) : activeGroup.custom === 'routes' ? (
			<RoutePanel t={props.t} data={personaData} disabled={!state.writable} />
		) : activeGroup.custom === 'tasks' ? (
			rpcAvailable ? (
				<TaskPanel t={props.t} data={taskData} disabled={!state.writable} />
			) : (
				<p className={css.hint}>{props.t('taskRpcUnavailable')}</p>
			)
		) : activeGroup.custom === 'memory' ? (
			rpcAvailable ? (
				<MemoryPanel t={props.t} getRpc={getRpc} disabled={!state.writable} />
			) : (
				<p className={css.hint}>{props.t('memoryRpcUnavailable')}</p>
			)
		) : undefined;
	const countBadge =
		logActive && log.entries.length > 0 ? (
			<span className={css.pending}>{props.t('logCount').replace('{count}', String(log.entries.length))}</span>
		) : undefined;
	return (
		<div className={css.section}>
			<h2 className={css.heading}>{props.t('title')}</h2>
			<p className={css.intro}>{props.t('description')}</p>
			{!state.writable ? (
				<p className={css.readOnly} role="status">
					{props.t('readOnly')}
				</p>
			) : null}
			<div className={css.layout}>
				<nav className={css.nav} aria-label={props.t('settingsNav')}>
					{navigation.map((entry) => (
						<div key={entry.section} className={css.navSection}>
							<p className={css.sectionHead}>{props.t(entry.section)}</p>
							<div className={css.navGroup}>
								{entry.groups.map((group) => {
									const shell = state.cards[group.id];
									const isActive = group.id === activeId;
									return (
										<button
											key={group.id}
											type="button"
											className={cls(css.navItem, isActive && css.navItemActive)}
											// 列宽收紧后长标签（英文尤其明显）会省略号截断，悬停仍能看全称。
											title={props.t(group.titleKey)}
											aria-current={isActive ? 'page' : undefined}
											onClick={() => {
												selectGroup(group.id);
											}}
										>
											<span className={css.navItemText}>{props.t(group.titleKey)}</span>
											{shell?.dirty === true ? <span className={css.navDot} title={props.t('unsaved')} /> : null}
											{group.id === CONNECTION_CARD_ID && transportConnected ? <span className={css.connDot} /> : null}
										</button>
									);
								})}
							</div>
						</div>
					))}
				</nav>
				<div className={css.content}>
					<ul className={css.cards}>
						<GroupCard
							{...props}
							group={activeGroup}
							state={state}
							open
							onOpenChange={() => {}}
							staticHeader
							extraBadge={
								activeGroup.id === CONNECTION_CARD_ID && transportConnected ? <ConnectedBadge t={props.t} /> : countBadge
							}
							extra={logActive ? <LogViewerPanel t={props.t} log={log} /> : undefined}
							statusBody={
								memoryConfigActive ? (
									<MemoryModelStatusPanel
										t={props.t}
										status={memoryStatus}
										onDownload={async (model) => {
											const rpc = getRpc?.();
											if (rpc === undefined) throw new Error(props.t('memoryRpcUnavailable'));
											const answer = await rpc('memory/models/download', { model });
											if (!answer.ok) throw new Error(answer.error?.message ?? '操作失败');
											const next = await rpc('memory/status', {});
											if (next.ok) setMemoryStatus(parseRagStatus(next.value));
										}}
									/>
								) : undefined
							}
							customBody={customBody}
							modelOptions={modelOptions}
						/>
					</ul>
				</div>
			</div>
		</div>
	);
}
