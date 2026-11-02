import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIM, HF_DEFAULT_HOST, downloadHost, embeddingDtype, mirrorHost } from './modelOptions.ts';
import { RAG_VEC_SCHEMA_SQL } from './schema.ts';

describe('模型下载源取值', () => {
	it('空值/空白回落官方地址', () => {
		expect(downloadHost('')).toBe(HF_DEFAULT_HOST);
		expect(downloadHost('   ')).toBe(HF_DEFAULT_HOST);
		expect(downloadHost(undefined)).toBe(HF_DEFAULT_HOST);
	});

	it('自定义地址去掉首尾空白后原样使用', () => {
		expect(downloadHost('  https://hf.internal.corp  ')).toBe('https://hf.internal.corp');
	});

	it('镜像空值 = 不启用镜像（不回落官方地址，否则会多打一次必然失败的请求）', () => {
		expect(mirrorHost('')).toBe('');
		expect(mirrorHost(undefined)).toBe('');
		expect(mirrorHost(' https://hf-mirror.com ')).toBe('https://hf-mirror.com');
	});
});

describe('embedding 精度取值', () => {
	it('默认 int8', () => {
		expect(embeddingDtype('')).toBe('int8');
		expect(embeddingDtype(undefined)).toBe('int8');
	});

	it('大小写与空白归一', () => {
		expect(embeddingDtype(' FP16 ')).toBe('fp16');
		expect(embeddingDtype('fp32')).toBe('fp32');
	});

	it('不认识的取值回落 int8，而不是把错误抛给 transformers.js', () => {
		expect(embeddingDtype('INT8')).toBe('int8');
		expect(embeddingDtype('q8')).toBe('int8');
		expect(embeddingDtype('int4')).toBe('int8');
		expect(embeddingDtype('量化')).toBe('int8');
	});
});

describe('embedding 模型与向量表', () => {
	// 换模型 = 换维度 = 向量表要重建 + 历史要重新向量化，所以模型 id 不是配置项：
	// 这两处必须一起改（worker 里还有运行时维度校验兜底）。
	it('向量表的维度跟着 EMBEDDING_DIM 走，没有第二处写死的数字', () => {
		const dims = [...RAG_VEC_SCHEMA_SQL.matchAll(/float\[(\d+)\]/g)].map((match) => Number(match[1]));
		expect(dims.length).toBeGreaterThan(0);
		expect(new Set(dims)).toEqual(new Set([EMBEDDING_DIM]));
	});
});
