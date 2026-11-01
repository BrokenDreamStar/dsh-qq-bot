/**
 * 把 transformers.js 的 progress 回调归一化成 WebUI 可渲染的进度。
 *
 * 不同版本字段不完全一致（file/name、progress/loaded/total），这里全部兼容；
 * 拿不到比例时返回 undefined percent，WebUI 用不确定进度条。
 */

import type { RagProgress } from './types.ts';

export interface DownloadProgressInput {
	status?: unknown;
	file?: unknown;
	name?: unknown;
	progress?: unknown;
	loaded?: unknown;
	total?: unknown;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeDownloadProgress(input: DownloadProgressInput, now = Date.now()): RagProgress {
	const status = asString(input.status) ?? 'download';
	const file = asString(input.file) ?? asString(input.name);
	const loaded = asNumber(input.loaded);
	const total = asNumber(input.total);
	const rawPercent = asNumber(input.progress);
	const percent =
		rawPercent !== undefined
			? Math.max(0, Math.min(100, rawPercent))
			: loaded !== undefined && total !== undefined && total > 0
				? Math.max(0, Math.min(100, (loaded / total) * 100))
				: status === 'done'
					? 100
					: undefined;
	const label = file !== undefined ? `${status} ${file}` : status;
	return {
		kind: 'download',
		message: label,
		...(file !== undefined ? { file } : {}),
		...(percent !== undefined ? { percent } : {}),
		...(loaded !== undefined ? { loaded } : {}),
		...(total !== undefined ? { total } : {}),
		at: now,
	};
}

/** 人类可读字节数（WebUI 进度条下方显示）。 */
export function formatBytes(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return '';
	if (value < 1024) return `${Math.round(value)} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
