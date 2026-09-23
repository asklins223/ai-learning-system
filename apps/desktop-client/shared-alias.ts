import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `@ailearn/shared` 的实时源码别名（2026-09-21），三处共用：`electron.vite.config.ts`
 * 的 main/preload/renderer，以及 `vitest.config.ts`。
 *
 * 为什么必须有这一份：pnpm 对 `file:` 依赖是**安装期快照**。没被改过的文件是硬链接，
 * 内容跟着 `packages/shared` 走；一旦某个契约文件被编辑过，编辑器写的是新 inode，
 * 快照里留下的就是编辑**之前**的那一份——于是"改了合同，测试还是绿的"。
 * 类型侧那一半在 tsconfig.web/node.json 的 paths 里指向源码，所以 `typecheck` 读源码、
 * `vitest` 读快照，两边可以同时"对"而互相不是同一份代码。
 *
 * 子路径全是 `src/*.ts` 平铺文件（桌面端没有 `@ailearn/shared/db-schema` 这类目录导入）。
 * 路径按本文件自己的位置算，不按 cwd：配置文件被谁加载、cwd 在哪，不该决定解析结果。
 */
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)))
const sharedSrc = resolve(here, '../../packages/shared/src')

export const sharedAlias = [
  { find: /^@ailearn\/shared$/, replacement: resolve(sharedSrc, 'index.ts') },
  { find: /^@ailearn\/shared\/(.*)$/, replacement: resolve(sharedSrc, '$1.ts') },
]
