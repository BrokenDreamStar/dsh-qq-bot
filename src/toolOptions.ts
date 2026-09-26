/**
 * 工具选择框的宿主→浏览器数据通道（两侧共用，零依赖）。
 *
 * 工具清单是运行时事实（随部署的 dsh 插件集变化），不能硬编码进浏览器
 * bundle。宿主把枚举到的工具名写进 userTools/blockedTools 字段的 schemastery
 * schema meta（`extra`），settings describe 会把整个 schema 序列化上行，
 * 浏览器半从这里读回选项；schema 未携带元数据时 WebUI 回退为文本框。
 */

/** schema meta 里携带工具选项的键（宿主写入 / 浏览器读取共用）。 */
export const TOOL_OPTIONS_META_KEY = 'dshqqToolOptions';

/**
 * 从序列化的 schemastery 信封（`schema.toJSON()` 形如 `{ uid, refs }`，
 * refs 按 uid 索引、object 节点的 dict 值为子节点 uid）读取某字段的工具选项。
 * 任何形状不符都返回 undefined，由调用方回退。
 */
export function readToolOptions(serialized: unknown, fieldKey: string): readonly string[] | undefined {
	if (serialized === null || typeof serialized !== 'object') return undefined;
	const envelope = serialized as { uid?: unknown; refs?: unknown };
	if (typeof envelope.uid !== 'number' || envelope.refs === null || typeof envelope.refs !== 'object') return undefined;
	const refs = envelope.refs as Record<string, unknown>;
	const root = refs[String(envelope.uid)];
	if (root === null || typeof root !== 'object') return undefined;
	const dict = (root as { dict?: unknown }).dict;
	if (dict === null || typeof dict !== 'object') return undefined;
	const childUid = (dict as Record<string, unknown>)[fieldKey];
	if (typeof childUid !== 'number') return undefined;
	const child = refs[String(childUid)];
	if (child === null || typeof child !== 'object') return undefined;
	const meta = (child as { meta?: unknown }).meta;
	if (meta === null || typeof meta !== 'object') return undefined;
	const options = (meta as Record<string, unknown>)[TOOL_OPTIONS_META_KEY];
	if (!Array.isArray(options)) return undefined;
	const names = options.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
	return names.length > 0 ? names : undefined;
}
