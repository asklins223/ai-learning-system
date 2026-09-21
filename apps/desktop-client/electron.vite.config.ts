import { config as loadDotenv } from 'dotenv'
import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// Keep local desktop development aligned with the root Compose .env. The
// values are consumed by the privileged main process only; they are not
// injected into renderer import.meta.env or exposed through preload.
loadDotenv({
  path: fileURLToPath(new URL('../../.env', import.meta.url)),
})

const rendererPublicRoot = resolve('src/renderer/public')
const packagingExcludedPublicPrefixes = [
  'assets/3d/',
]

function isPackagingExcludedPublicPath(relativePath: string): boolean {
  return packagingExcludedPublicPrefixes.some((prefix) => (
    relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix)
  ))
}

function releasePublicAssetsPlugin(): Plugin {
  return {
    name: 'ailearn-release-public-assets',
    apply: 'build',
    // Vite normally copies the entire public directory. The public tree also
    // holds migration/reference archives that are intentionally available in
    // local development but are not runtime inputs. Disable that blanket copy
    // for production and emit only the non-excluded files with stable paths.
    config: () => ({ publicDir: false }),
    async buildStart() {
      const emitDirectory = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
          const absolutePath = resolve(directory, entry.name)
          const relativePath = relative(rendererPublicRoot, absolutePath).split(sep).join('/')
          if (isPackagingExcludedPublicPath(relativePath)) continue
          if (entry.isDirectory()) {
            await emitDirectory(absolutePath)
            continue
          }
          if (!entry.isFile()) {
            throw new Error(`Unsupported renderer public entry: ${relativePath}`)
          }
          this.emitFile({
            type: 'asset',
            fileName: relativePath,
            source: await readFile(absolutePath),
          })
        }
      }

      await emitDirectory(rendererPublicRoot)
    },
  }
}

/**
 * `@ailearn/shared` 的实时源码别名（2026-09-21）。
 *
 * 与 `apps/api`、`workers/ai-worker` 的 tsconfig `paths` 同一个目的：此前桌面端经
 * `node_modules/@ailearn/shared`（pnpm 对 `file:` 依赖的**安装期快照**）解析，改了
 * `packages/shared` 的契约在打包与运行里默认不可见 —— 只能手工 rsync 覆写快照，
 * 否则改动"看起来没生效"。类型侧那一半在 tsconfig.web/node.json 的 paths 里。
 *
 * 子路径全是 `src/*.ts` 平铺文件（桌面端没有 `@ailearn/shared/db-schema` 这类目录导入）。
 */
const sharedAlias = [
  { find: /^@ailearn\/shared$/, replacement: resolve('../../packages/shared/src/index.ts') },
  { find: /^@ailearn\/shared\/(.*)$/, replacement: resolve('../../packages/shared/src/$1.ts') },
]

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      // Shared contracts are source-only TypeScript. Bundle them into the
      // packaged main process so Electron never tries to require a .ts export
      // from the workspace at runtime.
      externalizeDeps: false,
      rollupOptions: {
        // `ws` 的两个可选原生加速依赖（笔记协同通道带进来的）。它们**故意不装**：
        // 没有它们 ws 会退到纯 JS 实现，行为一致。但 Vite 的依赖打包会给解析不到的
        // 可选 peer 生成一句**模块顶层**的 throw（out/main/index.js 里
        // `throw new Error('Could not resolve "bufferutil" imported by "ws"')`），
        // 那会在 Electron 启动时直接炸掉整个主进程，ws 自己的 try/catch 根本轮不到。
        // 标成 external 后运行时是普通 require：解析不到 → ws 捕获 → 走纯 JS。
        external: ['bufferutil', 'utf-8-validate'],
      },
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // Preload is executed from the packaged artifact, outside Node's
      // workspace resolver; keep the IPC schemas inside the preload bundle.
      externalizeDeps: false
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    base: './',
    resolve: {
      alias: [
        { find: '@renderer', replacement: resolve('src/renderer/src') },
        ...sharedAlias,
      ],
    },
    server: {
      // 别名指向仓库根的 packages/shared，dev server 默认只允许 root 内的文件。
      fs: { allow: [resolve('../..')] },
    },
    plugins: [react(), releasePublicAssetsPlugin()]
  }
})
