/**
 * 收图：把消息里的图片段解析成本地文件，交给 agent（文本里给
 * `Image: <本地路径>`，agent 用自己的文件/视觉工具读取——与官方
 * tencent-connect 插件相同的模式，避免 base64 膨胀上下文）。
 *
 * 解析顺序：段自带 url → 直接下载；file 是本机存在的路径 → 拷贝；
 * 否则调 get_image 换取 url/path 再走前两条。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DshQQConfig } from '../config.ts';
import type { OneBotApi } from '../onebot/api.ts';
import type { OBImageSegment } from '../onebot/segments.ts';
import type { Logger } from '../types.ts';

export interface MediaRef {
	kind: 'image';
	/** 本地绝对路径。 */
	path: string;
	/** 是否通过 get_image 解析。 */
	resolved: boolean;
}

function extFrom(name: string, fallback = 'jpg'): string {
	const match = /\.([a-zA-Z0-9]{2,5})(?:[?#].*)?$/.exec(name);
	return match?.[1]?.toLowerCase() ?? fallback;
}

async function downloadTo(url: string, dest: string, maxBytes: number, timeoutMs: number): Promise<void> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (declared > maxBytes) throw new Error(`image too large (${declared} bytes)`);
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > maxBytes) throw new Error(`image too large (${buffer.byteLength} bytes)`);
	const { writeFileSync } = await import('node:fs');
	writeFileSync(dest, Buffer.from(buffer));
}

/** 解析一条消息里的全部图片；失败的跳过并记日志（不阻断文本处理）。 */
export async function resolveImages(
	images: OBImageSegment[],
	options: {
		api: OneBotApi;
		config: DshQQConfig;
		/** 本会话媒体目录（`<会话目录>/media/<chatKey>`；由 bridge.mediaDir 给出）。 */
		mediaDir: string;
		logger: Logger;
		msgId: string;
	},
): Promise<MediaRef[]> {
	if (images.length === 0 || !options.config.mediaEnabled) return [];
	const dir = options.mediaDir;
	try {
		mkdirSync(dir, { recursive: true });
	} catch (error) {
		options.logger.warn(`dsh-qq-bot: 创建媒体目录失败: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const maxBytes = options.config.mediaMaxMB * 1024 * 1024;
	const refs: MediaRef[] = [];
	for (const [index, image] of images.entries()) {
		const stamp = `${Date.now()}-${index}`;
		let ext = extFrom(image.data.file ?? '', extFrom(image.data.url ?? ''));
		const candidates: Array<() => Promise<{ source: 'url' | 'path' | 'copy'; value: string } | null>> = [];
		if (image.data.url !== undefined && /^https?:\/\//.test(image.data.url)) {
			candidates.push(() => Promise.resolve({ source: 'url', value: image.data.url! }));
		}
		candidates.push(async () => {
			const info = await options.api.getImage(image.data.file);
			if (info === undefined) return null;
			if (info.path !== undefined && existsSync(info.path)) {
				ext = extFrom(info.path, ext);
				return { source: 'copy', value: info.path };
			}
			if (info.url !== undefined && /^https?:\/\//.test(info.url)) {
				ext = extFrom(info.url, ext);
				return { source: 'url', value: info.url };
			}
			if (info.file !== undefined && existsSync(info.file)) {
				ext = extFrom(info.file, ext);
				return { source: 'copy', value: info.file };
			}
			return null;
		});
		if (image.data.file !== undefined && existsSync(image.data.file)) {
			candidates.push(() => Promise.resolve({ source: 'copy', value: image.data.file }));
		}
		let saved = false;
		for (const candidate of candidates) {
			try {
				const source = await candidate();
				if (source === null) continue;
				const dest = join(dir, `in-${options.msgId}-${stamp}.${ext}`);
				if (source.source === 'url') {
					await downloadTo(source.value, dest, maxBytes, options.config.httpTimeoutMs);
				} else {
					if (statSync(source.value).size > maxBytes) throw new Error('image too large');
					copyFileSync(source.value, dest);
				}
				refs.push({ kind: 'image', path: dest, resolved: true });
				saved = true;
				break;
			} catch (error) {
				options.logger.warn(`dsh-qq-bot: 图片解析失败(${image.data.file}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (!saved) options.logger.warn(`dsh-qq-bot: 图片未能落盘，消息中将只保留占位符 (${options.msgId})`);
	}
	return refs;
}

/** 把媒体引用转成 agent 消息里的附加上下文行。 */
export function renderMediaLines(refs: MediaRef[]): string {
	if (refs.length === 0) return '';
	return refs.map((ref) => `Image: ${ref.path}`).join('\n');
}
