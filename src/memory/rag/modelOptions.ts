/**
 * 模型下载源与 ONNX 精度的取值（纯逻辑，可单测）。
 *
 * 这两个值只在配置文件里配（设置页不暴露，见 AGENTS.md「下载源与精度不占设置页」）：
 * 取值统一收口在这里，空值/非法值一律回落到安全默认——一个笔误（`INT8`、`q8`、
 * 拼错的单词）不该让向量召回静默退化成 FTS-only。
 */

/**
 * embedding 模型与其输出维度——**必须成对改**。
 *
 * 向量表按 `EMBEDDING_DIM` 建（sqlite-vec 的 `float[N]`，定长列），换模型 = 换维度 =
 * 建表语句要改、历史 chunk 要全部重新向量化。所以模型 id 不是配置项：它和存储格式
 * 绑死，改它属于代码变更（连同 `RAG_VEC_SCHEMA_SQL` 与 worker 的维度校验一起）。
 * 想换模型时先确认新模型输出多少维，再整包改这里。
 */
export const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';
export const EMBEDDING_DIM = 512;

/** 官方下载源（`memoryHfEndpoint` 的回落值）。 */
export const HF_DEFAULT_HOST = 'https://huggingface.co';

/** 支持的 ONNX 精度（transformers.js 的 dtype）。 */
export const EMBEDDING_DTYPES = ['int8', 'fp16', 'fp32'] as const;

/** 合法的 embedding 精度。 */
export type EmbeddingDtype = (typeof EMBEDDING_DTYPES)[number];

/** 下载源：空串回落官方地址（配置来自 cordis.patch.yml 时可能是空串）。 */
export function downloadHost(configured: string | undefined): string {
	const trimmed = (configured ?? '').trim();
	return trimmed === '' ? HF_DEFAULT_HOST : trimmed;
}

/** 镜像地址：空串 = 不启用镜像（返回空串，调用方据此跳过重试）。 */
export function mirrorHost(configured: string | undefined): string {
	return (configured ?? '').trim();
}

/** 精度：去空白、转小写；不认识的取值回落 int8（默认精度）。 */
export function embeddingDtype(configured: string | undefined): EmbeddingDtype {
	const value = (configured ?? '').trim().toLowerCase();
	return (EMBEDDING_DTYPES as readonly string[]).includes(value) ? (value as EmbeddingDtype) : 'int8';
}
