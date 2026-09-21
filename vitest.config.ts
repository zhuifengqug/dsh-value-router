import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 测试文件统一用 `node:test` 的 API 书写（见 test/node-test-shim.ts 的说明）：
      // vitest 运行时把 node:test 映射到等价 shim，`node --test` 则用 Node 自带实现。
      'node:test': fileURLToPath(new URL('./test/node-test-shim.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
})
