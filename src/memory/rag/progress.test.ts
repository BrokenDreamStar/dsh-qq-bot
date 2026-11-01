import { describe, expect, it } from 'vitest';
import { createModelStatus, formatBytes, modelProgress, normalizeDownloadProgress, setModelDownload, setModelLoad } from './progress.ts';

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

describe('模型两阶段状态', () => {
	it('启用与禁用状态明确区分', () => {
		expect(createModelStatus('bge', true)).toEqual({ id: 'bge', download: 'missing', load: 'missing' });
		expect(createModelStatus('bge', false)).toEqual({ id: 'bge', download: 'disabled', load: 'disabled' });
	});

	it('下载与加载独立推进，成功后清除旧错误', () => {
		let model = createModelStatus('bge', true);
		model = setModelDownload(model, 'error', 'network');
		expect(model).toMatchObject({ download: 'error', load: 'missing', error: 'network' });
		model = setModelLoad(setModelDownload(model, 'ready'), 'ready');
		expect(model).toEqual({ id: 'bge', download: 'ready', load: 'ready' });
	});

	it('进度带上所属模型，便于页面分别展示', () => {
		const progress = modelProgress(normalizeDownloadProgress({ status: 'progress', progress: 30 }, 1), 'reranker');
		expect(progress.model).toBe('reranker');
		expect(progress.percent).toBe(30);
	});
});
