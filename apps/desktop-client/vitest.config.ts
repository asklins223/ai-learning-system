import { defineConfig } from 'vitest/config'

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
 * 它消除的只是"机器忙不过来"这类与代码无关的红灯。其余配置保持 vitest 默认，
 * 避免无意改变模块解析或测试环境（环境由各文件顶部的 `@vitest-environment` 声明）。
 */
export default defineConfig({
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
