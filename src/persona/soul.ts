/**
 * 每会话人格文件：`<会话目录>/SOUL.md`。
 *
 * 设计取舍：
 *  - 文件是**唯一生效源**；`personas.json` 只做模板库，`chat-overrides.json`
 *    只保留模型（旧 persona 字段仅用于首次播种，不再影响已存在的 SOUL.md）。
 *  - 首次建 agent 时若 SOUL.md 不存在，用当前解析出的人格播种一次；已存在
 *    绝不覆盖，空文件回退模板但不写盘（避免误清空后静默改回模板）。
 *  - 文件读写都是同步的：人格是 agent setup 的一部分，且只有启动/重建时才读。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOUL_FILE = 'SOUL.md';
/** 单个人格文件的大小上限（字符）。 */
export const MAX_SOUL_CHARS = 20_000;

export type SoulSource = 'file' | 'seeded' | 'template' | 'empty';

export interface SoulInfo {
	/** 文件绝对路径。 */
	path: string;
	/** 实际用于注入的正文（文件为空/不存在时是模板回退）。 */
	text: string;
	/** 文件是否存在。 */
	exists: boolean;
	/** file = 文件生效；seeded = 本次播种；template = 文件不存在，用模板；empty = 文件存在但为空。 */
	source: SoulSource;
	/** 正文字符数（Unicode code points）。 */
	chars: number;
	/** 读写失败原因（不影响回退文本）。 */
	error?: string;
}

export function soulPath(sessionDir: string): string {
	return join(sessionDir, SOUL_FILE);
}

function charCount(text: string): number {
	return [...text].length;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

/** 读 SOUL.md 原文；不存在/读失败返回 undefined。 */
export function readSoulText(sessionDir: string): string | undefined {
	const path = soulPath(sessionDir);
	if (!existsSync(path)) return undefined;
	return readText(path);
}

/**
 * 写 SOUL.md（原子替换；目录不存在则创建）。
 * 空内容允许写入，但注入时会回退模板（见 `inspectSoul`）。
 */
export function writeSoulText(sessionDir: string, text: string): { ok: true; path: string } | { ok: false; error: string } {
	const path = soulPath(sessionDir);
	try {
		mkdirSync(sessionDir, { recursive: true });
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, text, 'utf8');
		renameSync(tmp, path);
		return { ok: true, path };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 只读检查（不播种）：给 WebUI / `/persona` 用。
 *
 * @param fallback - 文件不存在/为空时使用的模板正文。
 */
export function inspectSoul(sessionDir: string, fallback: string): SoulInfo {
	const path = soulPath(sessionDir);
	if (!existsSync(path)) {
		return { path, text: fallback, exists: false, source: 'template', chars: charCount(fallback) };
	}
	const raw = readText(path);
	if (raw === undefined) {
		return { path, text: fallback, exists: true, source: 'empty', chars: 0, error: '读取 SOUL.md 失败，已回退模板' };
	}
	if (raw.trim() === '') {
		return { path, text: fallback, exists: true, source: 'empty', chars: 0 };
	}
	return { path, text: raw, exists: true, source: 'file', chars: charCount(raw) };
}

/**
 * agent setup 时调用：文件不存在就用当前人格播种一次；存在则原样使用。
 * 播种失败也返回模板正文（agent 仍能工作），错误由 bridge 记日志。
 */
export function ensureSoul(sessionDir: string, fallback: string): SoulInfo {
	const current = inspectSoul(sessionDir, fallback);
	if (current.exists) return current;
	if (fallback.trim() === '') {
		return { ...current, source: 'template', text: '', chars: 0 };
	}
	const written = writeSoulText(sessionDir, fallback);
	if (!written.ok) {
		return { ...current, source: 'template', error: `播种 SOUL.md 失败：${written.error}` };
	}
	return {
		path: written.path,
		text: fallback,
		exists: true,
		source: 'seeded',
		chars: charCount(fallback),
	};
}

