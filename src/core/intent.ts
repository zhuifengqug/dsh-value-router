/**
 * 任务路由意图：难度 / 角色 / 显式线路的归一化、校验与成员复用键。
 *
 * 纯函数，不依赖运行时。三个概念在这里被冻结成唯一真源，宿主侧、服务侧、UI 侧共用：
 *
 * - **difficulty**：`low | medium | high | max`。缺省 `medium`；**给了非法值必须显式报错**，
 *   不允许静默回落到缺省（静默回落会让主模型以为"我标了 high"而实际跑在 medium 上）。
 * - **role**：原始自由文本，缺省 `general`。`normalizedRole` = trim + 连续空白合并 + Unicode 小写化。
 *   角色是自由文本，所以"非法"只有一种：**归一化后为空**。
 * - **route**：可选的显式线路（provider / model / reasoning_effort 三者皆可选填）。
 */

import {
  DEFAULT_DIFFICULTY,
  DEFAULT_ROLE,
  isCompleteLine,
  isDifficulty,
  type Difficulty,
} from './config.ts'

/** 角色归一化：trim → 连续空白合并为单个空格 → Unicode 小写化。 */
export function normalizeRole(role: unknown): string {
  if (typeof role !== 'string') return ''
  return role.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** 显式线路的原始输入（三字段皆可缺）。 */
export interface RouteIntent {
  provider?: unknown
  model?: unknown
  reasoning_effort?: unknown
}

/** 归一化后的显式线路。 */
export interface NormalizedRoute {
  provider: string
  model: string
  reasoning_effort: string
}

/**
 * 线路来源。
 *
 * - `user`：用户在 staged 计划里**硬指定**的线路。不可用时任务保持 pending/blocked，**绝不**自动换线路或走 fallback。
 * - `captain`：主模型给出的 route 偏好。非法时只记录 `route-rejected`，然后回到难度/角色自动重选。
 * - `difficulty`：按 difficulty 档位自动选择（含档内轮转 / 同档替代 / 逐档降级）。
 * - `fallback`：四档全部无可用线路时的全局兜底。
 * - `none`：没有解析出任何线路。
 */
export type RouteSource = 'user' | 'captain' | 'difficulty' | 'fallback' | 'none'

/** 路由结果状态。 */
export type RouteStatus =
  /** 已解析出可直接派发的 provider/model/reasoning_effort。 */
  | 'resolved'
  /** 有合法意图但当前无可用线路（用户硬路由不可用 / 四档与兜底都空）——**不得派发**，等环境变化。 */
  | 'pending'
  /** 意图本身非法（非法 difficulty/role、用户硬路由非法或被白名单挡住）——**不得派发**，需人介入。 */
  | 'blocked'

/** 校验结果。 */
export interface RouteValidation {
  ok: boolean
  /** 显式错误信息（空 = 通过）。非法 difficulty/role 必须在这里出现，不得静默回落。 */
  errors: string[]
  /** 归一化后的难度（校验失败时为 undefined）。 */
  difficulty?: Difficulty
  /** 归一化后的角色（校验失败时为 undefined）。 */
  role?: string
  normalizedRole?: string
  /** 归一化后的显式线路（未给出时为 undefined）。 */
  route?: NormalizedRoute
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 校验并归一化一份路由意图。
 *
 * 缺省（字段缺失）合法：difficulty→medium，role→general。
 * 显式给出非法值一律进 `errors`，并让 `ok=false`。
 */
export function validateRouteIntent(input: {
  difficulty?: unknown
  role?: unknown
  route?: RouteIntent | null | undefined
}): RouteValidation {
  const errors: string[] = []

  let difficulty: Difficulty | undefined
  if (input.difficulty === undefined || input.difficulty === null) {
    difficulty = DEFAULT_DIFFICULTY
  } else if (isDifficulty(input.difficulty)) {
    difficulty = input.difficulty
  } else {
    errors.push(`invalid difficulty ${JSON.stringify(input.difficulty)}: expected one of low, medium, high, max`)
  }

  let normalizedRole: string | undefined
  if (input.role === undefined || input.role === null) {
    normalizedRole = DEFAULT_ROLE
  } else if (typeof input.role !== 'string') {
    errors.push(`invalid role ${JSON.stringify(input.role)}: expected a string`)
  } else {
    normalizedRole = normalizeRole(input.role)
    if (normalizedRole === '') errors.push('invalid role: must contain at least one non-whitespace character')
  }

  let route: NormalizedRoute | undefined
  if (input.route !== undefined && input.route !== null) {
    if (typeof input.route !== 'object') {
      errors.push('invalid route: expected an object with provider/model/reasoning_effort')
    } else {
      const candidate: NormalizedRoute = {
        provider: str(input.route.provider),
        model: str(input.route.model),
        reasoning_effort: str(input.route.reasoning_effort),
      }
      if (isCompleteLine(candidate)) {
        route = candidate
      } else {
        errors.push('invalid route: provider and model must both be non-empty')
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(normalizedRole === undefined ? {} : { role: normalizedRole, normalizedRole }),
    ...(route === undefined ? {} : { route }),
  }
}

/**
 * 成员复用键：`difficulty + normalizedRole + provider + model + reasoning_effort`。
 *
 * 五段用 `\u0000` 连接，避免角色文本里的 `|` `/` 之类与分隔符撞车导致不同键碰撞。
 */
export function memberReuseKey(input: {
  difficulty: Difficulty | string
  normalizedRole: string
  provider: string
  model: string
  reasoning_effort?: string
}): string {
  return [
    input.difficulty,
    input.normalizedRole,
    input.provider,
    input.model,
    input.reasoning_effort ?? '',
  ].join('\u0000')
}
