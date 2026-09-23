import { defineConfig } from 'vitest/config'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedAlias } from './shared-alias.ts'

// 配置自己所在的目录（不要再套一层 dirname——那会退到 apps/，node_modules 就找不到了）
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)))

/**
 * 返回"y-prosemirror 实际链接到的那份 prosemirror-model"的入口文件。
 * 解析不出来就抛：这段 alias 一旦静默失效，note-doc-editor-binding 会退回
 * RangeError 红，而配置本身看起来毫无异常——兜底必须喊。
 */
function prosemirrorResolve() {
  const pnpmDir = join(here, 'node_modules', '.pnpm')
  const yDirs = readdirSync(pnpmDir).filter((d) => d.startsWith('y-prosemirror@'))
  if (yDirs.length !== 1) throw new Error(`[vitest.config] y-prosemirror 目录数=${yDirs.length}，无法确定该对齐哪一份 prosemirror-model`)
  const pkgDir = realpathSync(join(pnpmDir, yDirs[0], 'node_modules', 'prosemirror-model'))
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const entry = pkg.module ?? pkg.main
  if (!entry) throw new Error(`[vitest.config] ${pkgDir} 的 package.json 没有 module/main，无法注入 prosemirror-model alias`)
  return { find: 'prosemirror-model', replacement: resolve(pkgDir, entry) }
}

/**
 * 桌面端测试配置。
 *
 * 此前没有这份配置，因此跑的是 vitest 默认值（`testTimeout: 5000`）。默认值对这套
 * 用例偏紧：它包含大量 jsdom + 模块图较重的用例（渲染整个 surface、驱动拖拽手势），
 * 而默认跑法是**并行多 worker**——并行度一高，这些用例就会随机撞到 5 秒上限。
 *
 * 症状是**同一个测试在单跑时通过、在全量并行时超时**：本地全量跑实测出现
 * `Test timed out in 5000ms`，而把同一批文件单独跑（`—no-file-parallelism`
 * 或只跑那几个文件）全部通过。这种"随机的红"会让人误以为改动破坏了东西——
 * 本轮回归就为此多花了几轮排查时间。
 *
 * 这里把超时放宽到 15s：**它不隐藏逻辑失败**——真正卡死的用例照样会失败，只是晚 10 秒；
 * 它消除的只是"机器忙不过来"这类与代码无关的红灯。除此之外只有 `resolve.alias`
 * 是显式加进去的两条（见下面），测试环境本身仍由各文件顶部的
 * `@vitest-environment` 声明。
 */
export default defineConfig({
  /**
   * `prosemirror-model` 在这台机器上有**两个不同 realpath 的实例**：
   * `node_modules/prosemirror-model` 是 npm/pnpm 混装留下的顶层真实目录，而
   * `y-prosemirror`（以及 @milkdown）链接到
   * `node_modules/.pnpm/prosemirror-model@<ver>/node_modules/prosemirror-model`。
   * 测试自己 `import { Schema } from "prosemirror-model"` 走前者，编辑器内部走后者，
   * 于是 `note-doc-editor-binding.test.tsx` 稳定红在
   * `RangeError: Can not convert <paragraph(…)> to a Fragment
   *  (looks like multiple versions of prosemirror-model were loaded)`。
   *
   * 为什么不是 `resolve.dedupe` / `server.deps.inline`：两者都实测无效。vitest 对
   * node_modules 走 SSR 外部化，`y-prosemirror` 的 require 根本不经过 vite 的解析层，
   * 所以 dedupe 只会把**测试这一侧**也拉到顶层那份，两边依旧不同实例。
   * 正解是让测试用**外部化消费者实际拿到的那一份**。
   *
   * 路径不写死版本号：直接读 y-prosemirror 自己链接到的那个符号链接并解析成 realpath，
   * 升级 prosemirror-model 后它自然跟着走；解析不出来就不注入 alias（宁可让测试红，
   * 也不要静默指向一份错的文件）。
   */
  resolve: {
    /**
     * `sharedAlias` 不是可选项：pnpm 对 `file:` 依赖是**安装期快照**，被编辑过的
     * `packages/shared` 文件在 `node_modules` 里留的是编辑前那一份（没编辑过的才是硬链接）。
     * 不指别名，桌面这套用例就在测一份和 `typecheck`（tsconfig paths → 源码）不是同一
     * 个文件的合同——两边可以同时绿，而绿的不是同一件事。
     */
    alias: [prosemirrorResolve(), ...sharedAlias],
  },

  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    /**
     * `waitFor` 的等待上限由 Testing Library 自己管（默认 1000ms），**不受**
     * `testTimeout` 影响——只调 vitest 超时，仍然会在机器忙时撞到它。
     * 这里通过 setup 文件统一放宽，覆盖的仍是"轮询等待"这类与代码无关的红灯。
     */
    setupFiles: ['./vitest.setup.ts'],
  },
})
