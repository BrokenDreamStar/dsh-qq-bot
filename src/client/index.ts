/**
 * dsh-qq-bot 的浏览器半（client bundle）：
 * 在 dsh WebUI 的 设置 页注册独立的「QQ（napcat）」配置 section（左列
 * 顶级入口，与 通用设置/模型/插件 同级）。页面按功能域分卡（见 form.ts 的
 * FIELD_GROUPS：一张卡 = 一个功能域，私聊/群聊的差异是卡内子分节），再按
 * sectionKey 分成「接入与安全 / 对话体验 / 运行与维护」三段，不占额外左列入口。
 *
 * bundle 契约（见 dsh-client-modules）：package.json 声明 dsh.client 且
 * exports["./client"] 指向本文件产出的 dist/client.js —— 一个以
 * window.__ModuleLoader__.load({ id, factory }) 包装的 cordis 客户端插件，
 * 导出 apply / inject。react 与 react/jsx-runtime 由 shell 基线提供。
 */
import { DshQQSection } from './components.tsx';
import { DshQQCardController, SETTINGS_NS } from './form.ts';
import { installNavIcon } from './icon.ts';
import { LOCALE_NS, en, zh } from './locales.ts';
import { injectCardCss } from './style.ts';
import type { ClientConnectionLike, ClientCtx, RpcCaller } from './types.ts';

/** 需要的客户端服务（由 manifest dsh.client.inject 列出的包提供）。 */
export const inject = ['slots', 'locale', 'settingsScope'];

/** 宿主 /dsh-qq-bot RPC 通道名（宿主半 index.ts 注册：logs/*、personas/*、routes/*、models/list）。 */
export const LOGS_RPC_CHANNEL = '/dsh-qq-bot';

/** 客户端插件入口。 */
export function apply(ctx: ClientCtx): void {
	injectCardCss('@deepseek-ai/dsh-qq-bot/section.css', 'dsh-qq-bot');
	ctx.effect(() => {
		const removeZh = ctx.locale.register(LOCALE_NS, 'zh', zh);
		const removeEn = ctx.locale.register(LOCALE_NS, 'en', en);
		return () => {
			removeZh();
			removeEn();
		};
	}, 'dsh-qq-bot: section dictionaries');
	// shell 对未知 section id 回退齿轮图标，这里把本插件条目的图标换为 QQ。
	installNavIcon(ctx, [zh.nav, en.nav].filter((label): label is string => typeof label === 'string' && label !== ''));

	// describe 镜像携带宿主注入的工具选项（userTools/blockedTools 选择框）；
	// 旧宿主没有 describe 时缺省，控件回退文本框。
	const describe = typeof ctx.settingsScope.describe === 'function' ? ctx.settingsScope.describe() : undefined;
	const controller = new DshQQCardController(ctx.settingsScope.bind({ namespace: SETTINGS_NS }), describe);
	const t = ctx.locale.bind(LOCALE_NS);
	// 宿主 RPC：消息日志视图 + 人格库 / 人格与模型（均走 /dsh-qq-bot 通道）。
	// connection 是 web profile 基线服务，但可能晚于本插件就绪，所以每次
	// 拉取时惰性解析；没有该服务（旧宿主）时日志与人格卡片降级为提示。
	// 注意：connection 不在 inject 声明里，ctx 上的属性读取会因 inject 门控
	// 直接抛错（曾导致整个配置页空白），必须走 .get() 并吞错降级。
	const getRpc = (): RpcCaller | undefined => {
		let connection: ClientConnectionLike | undefined;
		try {
			connection = (ctx as unknown as { get(name: string): unknown }).get('connection') as ClientConnectionLike | undefined;
		} catch {
			return undefined;
		}
		if (connection === undefined || typeof connection.rpc?.call !== 'function') return undefined;
		return (endpoint, payload) => connection.rpc.call(LOGS_RPC_CHANNEL, endpoint, payload);
	};
	// 设置左列顶级 section（general=0 / models=10 / plugins=15 / agent-presets=20，
	// 本插件排在其后）。页内的分区与卡片都不是左列入口。
	ctx.slots.inject('settings.section', () =>
		ctx.slots.register(
			{
				name: 'settings.section',
				id: SETTINGS_NS,
				order: 25,
				label: () => t('nav'),
				locale: LOCALE_NS,
				inject: () => ({ ...controller.inject(), getRpc }),
			},
			DshQQSection as unknown as (props: Record<string, unknown>) => unknown,
		),
	);
}
