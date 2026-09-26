/**
 * 记忆写入侧的安全扫描（纯逻辑，可测）。
 *
 * 为什么需要：卡片会被注入 **system prompt**，检索结果会进本轮上下文，
 * 而 QQ 是**无认证入口** —— 任何群成员说一句话就可能被蒸馏成一条"事实"。
 * 所以写入前必须过一遍威胁扫描（对齐 hermes-agent 的 `tools/threat_patterns.py`
 * 的 strict 档），命中即**整条拒绝**，不落库。
 *
 * 三类威胁：
 *  1. prompt injection：试图让模型忽略既有规则/改变身份/执行指令；
 *  2. 凭证外泄：诱导把 API key、私钥、密码之类发出去；
 *  3. 不可见字符：零宽字符、双向控制符、BOM 等（可用来隐藏指令或伪造文本）。
 *
 * 另外提供文本清洗：任何进入库或 prompt 的字符串都先过 `sanitizeMemoryText`，
 * 去掉控制字符并统一空白 —— 记忆内容**只经渲染器输出**，不做任何模板求值。
 */

export interface ThreatFinding {
	/** 命中的类别，用于日志。 */
	kind: 'injection' | 'exfiltration' | 'invisible';
	/** 命中的模式（正则源码）或字符码位。 */
	pattern: string;
}

export interface ThreatVerdict {
	ok: boolean;
	findings: ThreatFinding[];
}

/** 零宽与双向控制字符（jsliang / 隐写常用）。 */
const INVISIBLE_PATTERN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/;

/** prompt injection 模式（中英双语，覆盖常见话术）。 */
const INJECTION_PATTERNS: readonly RegExp[] = [
	/ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instruction|prompt|rule|message)/i,
	/disregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)/i,
	/you\s+are\s+now\s+(a|an|the)\s+/i,
	/\bnew\s+(system\s+)?(instruction|prompt|rule)s?\s*[:：]/i,
	/system\s*prompt\s*[:：]/i,
	/忽略(之前|上面|以上|先前|前面)的?(所有)?(指令|提示|规则|要求|设定)/,
	/(忘记|忘掉|清除)(你)?(之前|原来|以上|所有)(的)?(指令|规则|设定|身份)/,
	/从现在(开始|起)[，,]?\s*(你|你要|你必须|请)/,
	/你现在(是|扮演|开始扮演)/,
	/(新的?|以下(是)?)(系统)?(指令|规则|设定)\s*[:：]/,
	/(执行|运行|调用)\s*(以下|下面|这条)?\s*(命令|脚本|指令)\s*[:：]/,
	/(把|将)?(你的)?(系统提示词?|system\s*prompt|初始设定|开发者消息)(完整)?(输出|打印|复述|告诉我)/i,
	/(不要|别)(再)?(遵守|理会|管)(之前|原来|上面)的/,
];

/** 凭证外泄/后门模式。 */
const EXFILTRATION_PATTERNS: readonly RegExp[] = [
	/\b(api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|password|passwd)\b\s*[:=]/i,
	/-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
	/authorized_keys/i,
	/(把|将)(你的)?(密钥|令牌|token|密码|api\s*key)(发|送|告诉|输出|上报)/i,
	/(curl|wget|nc|ncat)\s+[^\s]*\s*\|\s*(ba)?sh/i,
	/ssh\s+-[a-z]*\s*[^\s]*@/i,
	/sk-[A-Za-z0-9]{16,}/,
];

/**
 * 扫描一段即将写入记忆的文本。
 *
 * 注意：**先扫原文再清洗**。不可见字符一旦被 `sanitizeMemoryText` 去掉就查不到了，
 * 而它恰恰是隐藏指令的常用手段 —— 所以调用方一定要把**原始输入**交给本函数。
 *
 * @param text - 待写入的原始内容（事实正文、条目、事件文本）。
 * @returns 判断结果；`ok=false` 时调用方必须拒绝写入（并把 findings 记进日志）。
 */
export function scanForThreats(text: string): ThreatVerdict {
	const findings: ThreatFinding[] = [];
	const invisible = INVISIBLE_PATTERN.exec(text);
	if (invisible !== null) {
		const code = invisible[0].codePointAt(0) ?? 0;
		findings.push({ kind: 'invisible', pattern: `U+${code.toString(16).toUpperCase().padStart(4, '0')}` });
	}
	for (const pattern of INJECTION_PATTERNS) {
		if (pattern.test(text)) findings.push({ kind: 'injection', pattern: pattern.source });
	}
	for (const pattern of EXFILTRATION_PATTERNS) {
		if (pattern.test(text)) findings.push({ kind: 'exfiltration', pattern: pattern.source });
	}
	return { ok: findings.length === 0, findings };
}

/**
 * 清洗进入记忆/提示词的文本：去控制字符（保留换行与制表）、去掉零宽/双向控制符、
 * 折叠空白、去首尾空白。不改变语义，只保证渲染安全。
 *
 * 控制字符替换成空串而不是空格：`a\u0000b` 应当仍是 `ab`，插一个空格会凭空
 * 造出词边界（检索与分析都会被影响）。
 */
export function sanitizeMemoryText(text: string): string {
	return text
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 归一化一条事实的 object：清洗 + 截断 + 拒绝空串。
 *
 * @returns 归一化后的文本，或 `undefined`（空 / 全是控制字符）。
 */
export function normalizeFactText(text: string, maxChars: number): string | undefined {
	const cleaned = sanitizeMemoryText(text);
	if (cleaned === '') return undefined;
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars - 1)}…`;
}

/** 把 findings 渲染成一行日志文本。 */
export function describeFindings(findings: readonly ThreatFinding[]): string {
	return findings.map((finding) => `${finding.kind}(${finding.pattern})`).join(', ');
}
