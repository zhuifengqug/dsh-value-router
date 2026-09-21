/**
 * vitest 侧的 `node:test` 等价 shim。
 *
 * 本包的测试统一用 `node:test` + `node:assert` 的 API 书写：这样既能用
 * `pnpm test`（vitest，见 vitest.config.ts 的 alias）跑，也能在受限环境里
 * 用 `node --test` 直接跑同一批文件，不需要第二套测试代码。
 */
export {
  test,
  it,
  describe,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from 'vitest'
