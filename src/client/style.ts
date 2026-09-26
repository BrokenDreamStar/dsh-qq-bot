/**
 * 配置页样式：规则与设计令牌（--dsw-alias-*）照搬 dsh 内置设置页
 * （PluginsSettingsSection.module.css / fields.module.css / 内置开关），
 * 类名换成 dshqq- 前缀自持，不依赖其他包的哈希类。注入方式与内置一致
 * （<style data-plugin-css> 去重）。
 */
export const CARD_CSS = `
.dshqq-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.dshqq-heading{margin:0;font-size:18px;font-weight:600}
.dshqq-intro{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:13px}
.dshqq-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.dshqq-cards{flex-direction:column;gap:10px;margin:12px 0 0;padding:0;list-style:none;display:flex}
.dshqq-sectionWrap{margin:14px 0 -2px;list-style:none}
.dshqq-sectionWrap:first-child{margin-top:4px}
.dshqq-sectionHead{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;font-weight:600;letter-spacing:.03em;line-height:1.5}
.dshqq-subHead{color:var(--dsw-alias-label-tertiary);margin:14px 0 0;font-size:12px;font-weight:600;line-height:1.5}
.dshqq-subHead:first-child{margin-top:4px}
.dshqq-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dshqq-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshqq-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshqq-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dshqq-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshqq-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshqq-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dshqq-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dshqq-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dshqq-chevronOpen{transform:rotate(180deg)}
.dshqq-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dshqq-pending{corner-shape:round;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dshqq-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dshqq-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dshqq-saved{min-width:0;color:var(--dsw-alias-state-success-primary);flex:1;margin:0;font-size:12px;line-height:1.5}
.dshqq-discard,.dshqq-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dshqq-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dshqq-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dshqq-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dshqq-discard:disabled,.dshqq-save:disabled{opacity:.4;cursor:default}
.dshqq-discard:focus-visible,.dshqq-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshqq-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dshqq-field+.dshqq-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dshqq-head{align-items:center;gap:8px;display:flex}
.dshqq-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dshqq-badges{align-items:center;gap:8px;display:inline-flex}
.dshqq-badge{corner-shape:round;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dshqq-badgeMuted{corner-shape:round;white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.dshqq-conn{corner-shape:round;white-space:nowrap;align-items:center;gap:5px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-success-primary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;display:inline-flex}
.dshqq-connDot{background:currentColor;border-radius:50%;flex:none;width:6px;height:6px}
.dshqq-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.dshqq-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshqq-reset:disabled{cursor:default}
.dshqq-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.dshqq-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshqq-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshqq-inputInvalid{border-color:var(--dsw-alias-label-error)}
.dshqq-textarea{height:auto;min-height:64px;padding:7px 12px;resize:vertical}
/* 原生 select 的下拉箭头锚定在 padding box 上，贴着右边框（约 5px）。用一圈透明的右边框
   把箭头往内推 --dshqq-select-inset，与左侧 12px 内边距呼应；整圈描边改由 box-shadow 补回。 */
.dshqq-select{width:100%;cursor:pointer;--dshqq-select-inset:8px;border:0;border-right:var(--dshqq-select-inset) solid #0000;box-shadow:0 0 0 .5px var(--dsw-alias-border-l4)}
.dshqq-select:focus-visible{border-right-color:#0000;box-shadow:0 0 0 .5px var(--dsw-alias-brand-primary)}
.dshqq-checkGrid{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:8px;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:0 16px;align-content:start;max-height:190px;padding:6px 12px;margin:2px 0;overflow-y:auto;display:grid}
.dshqq-checkItem{align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:2;cursor:pointer;display:flex}
.dshqq-checkItem input{accent-color:var(--dsw-alias-brand-primary);flex:none;margin:0;cursor:pointer}
.dshqq-checkItem input:disabled{cursor:default}
.dshqq-checkItem span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshqq-chipRow{flex-wrap:wrap;align-items:center;gap:6px;margin:2px 0;display:flex}
.dshqq-chipRowLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshqq-chip{corner-shape:round;white-space:nowrap;align-items:center;gap:2px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 4px 1px 8px;font-size:11px;font-weight:500;line-height:17px;display:inline-flex}
.dshqq-chipRemove{appearance:none;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;padding:0 3px;font-size:13px;line-height:1}
.dshqq-chipRemove:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshqq-chipRemove:disabled{cursor:default}
.dshqq-chipAdd{align-items:center;gap:8px;display:flex}
.dshqq-chipAdd .dshqq-input{flex:1;min-width:0}
/* 顺序列表（orderList）：行 = 序号 + 名称 + 右侧上下箭头/移出，行间细分隔线。 */
.dshqq-orderList{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:8px;flex-direction:column;margin:2px 0;padding:2px 10px;list-style:none;display:flex}
.dshqq-orderRow{align-items:center;gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:5px 0;display:flex}
.dshqq-orderRow:last-child{border-bottom:none}
.dshqq-orderIndex{color:var(--dsw-alias-label-tertiary);flex:none;min-width:14px;font-size:12px;line-height:1.5;text-align:right;font-variant-numeric:tabular-nums}
.dshqq-orderName{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshqq-orderOps{align-items:center;gap:4px;flex:none;display:inline-flex}
.dshqq-orderArrow,.dshqq-orderRemove{appearance:none;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;width:24px;height:24px;padding:0;font-size:12px;line-height:1}
.dshqq-orderArrow:hover:not(:disabled),.dshqq-orderRemove:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dshqq-orderRemove:hover:not(:disabled){color:var(--dsw-alias-label-error)}
.dshqq-orderArrow:disabled,.dshqq-orderRemove:disabled{cursor:default;opacity:.35}
.dshqq-orderArrow:focus-visible,.dshqq-orderRemove:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshqq-orderAdd{appearance:none;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-module-platform);border:1px solid #0000;border-radius:999px;padding:1px 10px;font-size:11px;font-weight:500;line-height:19px}
.dshqq-orderAdd:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshqq-orderAdd:disabled{cursor:default;opacity:.5}
.dshqq-orderAdd:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshqq-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.dshqq-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dshqq-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}
.dshqq-toggleRow .dshqq-label{flex:1}
.dshqq-switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative}
.dshqq-switchOn{background:var(--dsw-alias-brand-primary)}
.dshqq-switch:disabled{cursor:default;opacity:.5}
.dshqq-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshqq-thumb{corner-shape:round;background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}
.dshqq-switchOn .dshqq-thumb{transform:translate(16px)}
.dshqq-logPanel{border-top:.5px solid var(--dsw-alias-border-l2)}
.dshqq-logToolbar{align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dshqq-logToolbar .dshqq-input{flex:1;min-width:0;height:30px}
.dshqq-logToolbar .dshqq-discard{flex:none}
.dshqq-logAutoOn{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshqq-logStatus{align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;white-space:nowrap;display:inline-flex}
.dshqq-logStatusLive{color:var(--dsw-alias-brand-primary)}
.dshqq-logDot{background:currentColor;border-radius:50%;flex:none;width:6px;height:6px}
.dshqq-logStatusLive .dshqq-logDot{animation:dshqq-logPulse 1.6s ease-in-out infinite}
@keyframes dshqq-logPulse{0%,100%{opacity:1}50%{opacity:.25}}
.dshqq-logList{margin:6px 0 0;padding:0;list-style:none}
.dshqq-logRow{align-items:baseline;gap:8px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:5px 0;font-size:12px;line-height:1.5;display:flex}
.dshqq-logRow:last-child{border-bottom:none}
.dshqq-logTime{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}
.dshqq-logDir{flex:none;border-radius:4px;padding:0 5px;font-size:11px;font-weight:600;line-height:18px;text-align:center;min-width:26px}
.dshqq-logDirIn{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary)}
.dshqq-logDirOut{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.dshqq-logDirSys{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.dshqq-logScope{color:var(--dsw-alias-label-tertiary);flex:none;min-width:44px}
.dshqq-logText{min-width:0;color:var(--dsw-alias-label-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all}
.dshqq-editor{flex-direction:column;gap:10px;padding:12px 0 4px;display:flex}
.dshqq-editorItem{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}
.dshqq-editorHead{align-items:center;gap:8px;display:flex}
.dshqq-editorHead .dshqq-input{flex:1;min-width:0}
.dshqq-editor .dshqq-textarea{min-height:74px}
.dshqq-routeHead,.dshqq-routeRowDefault,.dshqq-routeRow{grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr) 28px;align-items:center;gap:8px;display:grid}
.dshqq-routeHead{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.03em;line-height:1.5}
.dshqq-routeRowDefault{padding-bottom:10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshqq-routeRowDefault .dshqq-select,.dshqq-routeRow .dshqq-select{width:100%}
/* 末列（模型）右侧只有 8px 栅格间隙 + 删除按钮列：把框按同样的内推量加宽，箭头原地不动，只把右边框外移。 */
.dshqq-routeRowDefault .dshqq-select:last-of-type,.dshqq-routeRow .dshqq-select:last-of-type{width:calc(100% + var(--dshqq-select-inset))}
.dshqq-routeDefaultLabel{background:var(--dsw-alias-bg-module-platform);height:34px;color:var(--dsw-alias-label-secondary);border-radius:8px;align-items:center;padding:0 12px;font-size:13px;font-weight:500;line-height:1.5;display:flex;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshqq-routeRemove{appearance:none;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-self:center;width:26px;height:26px;font-size:15px;line-height:1}
.dshqq-routeRemove:hover:not(:disabled){color:var(--dsw-alias-label-error)}
.dshqq-routeRemove:disabled{cursor:default;opacity:.4}
.dshqq-taskHead{align-items:center;gap:8px;display:flex}
.dshqq-taskHead .dshqq-input{flex:1;min-width:0}
.dshqq-taskHead .dshqq-select{flex:none;width:auto;min-width:96px}
.dshqq-taskChat{corner-shape:round;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dshqq-taskSchedule{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshqq-taskPrompt{min-width:0;margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
.dshqq-taskMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums}
.dshqq-taskOps{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.dshqq-taskOps .dshqq-discard{padding:3px 10px;font-size:12px}
.dshqq-taskWeek{flex-wrap:wrap;gap:0 12px;display:flex}
@media (max-width:560px){
.dshqq-routeHead{display:none}
.dshqq-routeRowDefault,.dshqq-routeRow{grid-template-columns:minmax(0,1fr) 28px}
.dshqq-routeRowDefault>*,.dshqq-routeRow>*{grid-column:1}
.dshqq-routeRow .dshqq-routeRemove{grid-column:2;grid-row:1}
}
`;

/** 注入一次页面样式（幂等）。 */
export function injectCardCss(tagId: string, pluginId: string): void {
	if (typeof document === 'undefined') return;
	if (document.querySelector(`style[data-plugin-css="${CSS.escape(tagId)}"]`) !== null) return;
	const tag = document.createElement('style');
	tag.dataset.plugin = pluginId;
	tag.dataset.pluginCss = tagId;
	tag.textContent = CARD_CSS;
	document.head.appendChild(tag);
}
