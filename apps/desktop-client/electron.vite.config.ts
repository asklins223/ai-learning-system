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

export default defineConfig({
  main: {
    build: {
      // Shared contracts are source-only TypeScript. Bundle them into the
      // packaged main process so Electron never tries to require a .ts export
      // from the workspace at runtime.
      externalizeDeps: false
    }
  },
  preload: {
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
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), releasePublicAssetsPlugin()]
  }
})
