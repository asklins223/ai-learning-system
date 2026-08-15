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
      "@/": rootDir + "/",
      "@ailearn/shared/companion-asr-contracts": path.join(rootDir, "../../packages/shared/src/companion-asr-contracts.ts"),
      "@ailearn/shared/desktop-pet-contracts": path.join(rootDir, "../../packages/shared/src/desktop-pet-contracts.ts"),
      "@ailearn/shared/companion-conversation-contracts": path.join(rootDir, "../../packages/shared/src/companion-conversation-contracts.ts"),
      "@ailearn/shared/companion-character-contracts": path.join(rootDir, "../../packages/shared/src/companion-character-contracts.ts"),
      "@ailearn/shared/companion-shell-contracts": path.join(rootDir, "../../packages/shared/src/companion-shell-contracts.ts"),
      "@ailearn/shared/constants": path.join(rootDir, "../../packages/shared/src/constants.ts"),
      "@ailearn/shared": path.join(rootDir, "../../packages/shared/src"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});
