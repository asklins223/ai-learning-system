import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * web 组件渲染测试基建（2026-08-12 建立）。
 *
 * - environment: jsdom（组件挂载/DOM 事件/localStorage 可用）
 * - 测试文件约定：<name>.vitest.tsx（与 node --test 的 *.test.ts 区分，
 *   避免两个 runner 互相捡文件）
 * - setup 注入 jsdom 缺省 API（matchMedia）
 * - alias @ -> src（与 tsconfig/Next 一致）
 */
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["**/*.vitest.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      // 与 tsconfig paths 一致：@/* -> 仓库根(web 根)
      "@": rootDir,
      "@ailearn/shared": path.join(rootDir, "../packages/shared/src"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});
