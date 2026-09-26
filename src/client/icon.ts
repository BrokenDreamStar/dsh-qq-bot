/**
 * 设置左列图标本地化：shell 的 navIcon 按内置 section id 硬编码、未知 id
 * 回退为设置齿轮，没有插件扩展点，因此在浏览器端把本插件条目里的齿轮
 * svg 原地替换为 QQ 图标（复用原 svg 的 class/尺寸属性，fill 用
 * currentColor 继承导航配色）。label 文案变化（语言切换/重渲染）后
 * MutationObserver 会重新替换。
 */
import type { ClientCtx } from './types.ts';

/** QQ 企鹅填充路径（simple-icons "TencentQQ"，24×24）。 */
const QQ_ICON_PATH =
	'M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673';

const ICON_MARKER = 'data-dshqq-nav-icon';

export function installNavIcon(ctx: ClientCtx, navLabels: readonly string[]): void {
	if (typeof document === 'undefined') return;

	const swap = (): void => {
		for (const button of document.querySelectorAll('nav button')) {
			const label = (button.textContent ?? '').trim();
			if (!navLabels.includes(label)) continue;
			const svg = button.querySelector('svg');
			if (svg === null || svg.hasAttribute(ICON_MARKER)) continue;
			svg.setAttribute(ICON_MARKER, '');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('fill', 'currentColor');
			svg.setAttribute('stroke', 'none');
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', QQ_ICON_PATH);
			svg.replaceChildren(path);
		}
	};

	const observer = new MutationObserver(swap);
	ctx.effect(() => {
		observer.observe(document.body, { childList: true, subtree: true });
		swap();
		return () => {
			observer.disconnect();
		};
	}, 'dsh-qq-bot: nav icon swap');
}
