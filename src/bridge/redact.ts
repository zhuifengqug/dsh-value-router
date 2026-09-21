/**
 * 发送前脱敏（规格 §5.2 上下文压缩 / §12 隐私与安全）。
 *
 * 纯文本处理，不依赖运行时。把凭据、密钥、连接串、个人标识、本地绝对路径
 * 等替换为固定标记，并返回命中类型清单，供委派决策判断"上下文是否可脱敏"。
 *
 * 原则：宁可多标记，不可漏发敏感内容；但避免误伤正常文本。
 */

export const REDACTED_SECRET = '<REDACTED_SECRET>'
export const REDACTED_PATH = '<REDACTED_PATH>'
export const REDACTED_PERSONAL_DATA = '<REDACTED_PERSONAL_DATA>'

export interface RedactionResult {
  text: string
  /** 命中的敏感类别（去重）。 */
  categories: string[]
  /** 是否命中任何敏感类别。 */
  hasSensitive: boolean
  /** 是否命中"硬凭据"（密钥/令牌/口令/私钥/连接串），用于最高优先级阻断。 */
  hasCredential: boolean
}

interface Rule {
  category: string
  credential: boolean
  pattern: RegExp
  replace: string
}

// 顺序敏感：私钥块 / 连接串 先于通用 token，避免被部分匹配吞掉。
const RULES: Rule[] = [
  {
    category: 'private-key',
    credential: true,
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    replace: REDACTED_SECRET,
  },
  {
    category: 'connection-string',
    credential: true,
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"']+/gi,
    replace: REDACTED_SECRET,
  },
  {
    category: 'bearer-token',
    credential: true,
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: REDACTED_SECRET,
  },
  {
    category: 'jwt',
    credential: true,
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: REDACTED_SECRET,
  },
  {
    category: 'api-key',
    credential: true,
    // 常见密钥前缀：sk-..., sk_live_..., ghp_..., github_pat_..., xox[baprs]-...,
    // AKIA...(AWS), AIza...(Google), npm 令牌 npm_...
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,})\b/g,
    replace: REDACTED_SECRET,
  },
  {
    category: 'cookie',
    credential: true,
    pattern: /\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi,
    replace: REDACTED_SECRET,
  },
  {
    category: 'credential-assignment',
    credential: true,
    // key = value 形式的口令/密钥赋值（值较长或含符号才认定，避免误伤普通等号）
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd|pwd|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',;]{8,}["']?/gi,
    replace: REDACTED_SECRET,
  },
  {
    category: 'email',
    credential: false,
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: REDACTED_PERSONAL_DATA,
  },
  {
    category: 'cn-mobile',
    credential: false,
    pattern: /\b1[3-9]\d{9}\b/g,
    replace: REDACTED_PERSONAL_DATA,
  },
  {
    category: 'student-id',
    credential: false,
    // 10 位纯数字（如学号 2330110767），前后非数字，避免误伤长数字/时间戳
    pattern: /(?<!\d)\d{10}(?!\d)/g,
    replace: REDACTED_PERSONAL_DATA,
  },
  {
    category: 'abs-path',
    credential: false,
    pattern: /(?:[A-Za-z]:\\(?:[^\\:*?"<>|\r\n]+\\?)+|\/(?:Users|home|var|opt|root|mnt)\/[^\s"'`<>|]+)/g,
    replace: REDACTED_PATH,
  },
]

export function redact(input: string): RedactionResult {
  let text = input ?? ''
  const categories = new Set<string>()
  let hasCredential = false
  for (const rule of RULES) {
    // 每次重置 lastIndex（全局正则复用会残留状态）
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(text)) {
      categories.add(rule.category)
      if (rule.credential) hasCredential = true
      rule.pattern.lastIndex = 0
      text = text.replace(rule.pattern, rule.replace)
    }
  }
  return {
    text,
    categories: [...categories],
    hasSensitive: categories.size > 0,
    hasCredential,
  }
}

/**
 * 截断过大的代码块：保留头尾，中间用标记省略。仅在允许发送代码片段时用于兜底，
 * 避免把整段/整文件源码发出去（规格 §3 / §12）。
 */
export function truncateCode(code: string, maxChars: number): { text: string; truncated: boolean } {
  const src = code ?? ''
  if (src.length <= maxChars) return { text: src, truncated: false }
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.floor(maxChars * 0.3)
  const omitted = src.length - head - tail
  return {
    text: `${src.slice(0, head)}\n\n/* …<TRUNCATED ${omitted} chars>… */\n\n${src.slice(src.length - tail)}`,
    truncated: true,
  }
}
