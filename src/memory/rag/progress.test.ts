import { describe, expect, it } from 'vitest';
import { formatBytes, normalizeDownloadProgress } from './progress.ts';

describe('download progress', () => {
	it('优先使用 progress 百分比', () => {
		const progress = normalizeDownloadProgress({ status: 'progress', file: 'onnx/model_int8.onnx', progress: 42.5 }, 1);
		expect(progress.percent).toBe(42.5);
		expect(progress.file).toBe('onnx/model_int8.onnx');
		expect(progress.message).toContain('onnx/model_int8.onnx');
	});

	it('没有百分比时用 loaded/total 计算', () => {
		const progress = normalizeDownloadProgress({ status: 'download', name: 'tokenizer.json', loaded: 50, total: 200 }, 1);
		expect(progress.percent).toBe(25);
		expect(progress.file).toBe('tokenizer.json');
	});

	it('done 视为 100%', () => {
		expect(normalizeDownloadProgress({ status: 'done', file: 'x' }, 1).percent).toBe(100);
	});

	it('拿不到比例时 percent 为 undefined（不确定进度）', () => {
		expect(normalizeDownloadProgress({ status: 'initiate', file: 'x' }, 1).percent).toBeUndefined();
	});

	it('字节格式化', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(24 * 1024 * 1024)).toBe('24.0 MB');
	});
});
