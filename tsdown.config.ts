/**
 * 构建配置：宿主侧（ESM，依赖走 node_modules 解析）+ 浏览器侧（自注册经典脚本）。
 *
 * 浏览器产物的形态约束（与 dsh-deepseek-web-delegate / dsh-value-mode 一致）：
 * dsh 的 client-modules 把 lib/client/index.js 作为普通 <script> 拼进启动 combo
 * 顺序执行，因此产物必须是经典脚本（不能出现 import/export 语句），标准形态是
 * `window.__ModuleLoader__.load({ id, factory })` 自注册工厂，由 banner/footer 提供。
 *
 * CSS Modules：客户端组件用 `import styles from './x.module.css'`。这里用一个
 * 内联插件（lightningcss 编译 + <style> 注入 + 导出类名映射）把 CSS 打成 JS 模块，
 * 避免产物里出现裸 CSS 导入。
 */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const PLUGIN_ID = '@gjs27/dsh-value-router'

/** 把 *.module.css 编译成「注入 <style> + 导出类名映射」的 JS 模块。 */
function cssModulesInline() {
  const PREFIX = '\0dsh-css-module:'
  // 解析后的 id 追加 `?dsh-style`：tsdown 0.22 在未安装 @tsdown/css 时会注册
  // css-guard 插件，对任何以 `.css` 结尾的模块 id 无条件报错；带查询串即可绕过，
  // 同时保留 `source.endsWith('.module.css')` 的识别条件。
  const SUFFIX = '?dsh-style'
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.module.css')) return null
      const abs = isAbsolute(source)
        ? source
        : resolvePath(dirname(importer ?? process.cwd()), source)
      return PREFIX + abs + SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(PREFIX)) return null
      const file = id.slice(PREFIX.length).replace(SUFFIX, '')
      const source = await readFile(file)
      const { code, exports } = transform({
        filename: file,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(exports ?? {})) classMap[local] = exp.name
      const tagId = `${PLUGIN_ID}/${file.split(/[\\/]/).pop() ?? 'style.css'}`
      const contents = [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
      return { code: contents, moduleType: 'js' as const }
    },
  }
}

// 服务端入口：ESM，@deepseek-ai/* 与 node:* 保持 external。
const server = defineConfig({
  entry: {
    index: 'src/index.ts',
    'status-controller': 'src/status-controller.ts',
    typert: 'src/typert.ts',
  },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  // 声明文件由 tsdown 产出（tsc 只做 --noEmit 类型检查，避免两套工具写同一个 lib）。
  dts: true,
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, 'react', 'react-dom', 'schemastery', 'zod'],
  },
})

// 浏览器入口：自注册经典脚本，react 由 loader 注入的 require 在运行时提供。
const client = defineConfig({
  entry: { 'client/index': 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  clean: false,
  dts: false,
  sourcemap: false,
  minify: false,
  outExtensions: () => ({ js: '.js' }),
  plugins: [cssModulesInline() as never],
  // .tsx 组件用 JSX；显式指定变换，避免依赖 tsconfig 解析（根 tsconfig 只有 references）。
  inputOptions: { transform: { jsx: 'react-jsx' } } as never,
  deps: {
    neverBundle: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      /^@deepseek-ai\//,
    ],
  },
  banner: [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PLUGIN_ID)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
  ].join('\n'),
  footer: ['    return module.exports;', '  },', '});'].join('\n'),
})

export default [server, client]
