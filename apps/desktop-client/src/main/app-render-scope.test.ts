/**
 * App 根组件的订阅面守卫（2026-09-22 性能重扫 M13 的一半）。
 *
 * 放在 src/main 侧而不是和被守卫的 `App.tsx` 同目录：渲染层那套 tsconfig 没有 node
 * 类型，测试里 `import { readFileSync } from "node:fs"` 直接 TS2307。
 *
 * 为什么要有这条：`App` 里每多订阅一个高频状态，代价不是"根组件重渲染一次"，而是
 * **整棵渲染树**重渲染——`room` 那段 JSX 在 App 自己的一次渲染里造出来，而渲染层没有
 * 任何 `React.memo` 能拦住它。`windowState` 就是这类状态里最频繁的之一（失焦、最小化、
 * `visibilitychange` 都戳它），所以它被从 App 上摘掉了。
 *
 * 这类改动在界面上看不出来，也没有渲染计数可断言，只能用形状断言兜。为了让这条断言
 * **不是天生就绿**，它同时验三件事：
 *   ① 真的读到了文件（内容非空、并且含有正向对照 `useRoomStore(`）——读空了会红；
 *   ② 路径按测试文件自己的位置解析，不按 CWD（否则换个目录跑就永远"通过"）；
 *   ③ 判据用紧正则，不用裸子串（`windowState` 这个词在注释里合法出现，见下面那段说明）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../renderer/src/App.tsx");
const source = readFileSync(APP_SOURCE, "utf8");

describe("App 根组件不订阅高频窗口状态", () => {
  it("正向对照：文件确实读到了，而且它本来就在订阅别的 store 字段", () => {
    expect(source.length).toBeGreaterThan(1000);
    // 少了这一条，"读不到文件"会伪装成"没有订阅"而通过。
    expect(source).toContain("useRoomStore((state) => state.");
  });

  it("不再订阅 windowState（订阅一次=每次失焦全树重渲染）", () => {
    const subscription = /useRoomStore\(\s*\(state\)\s*=>\s*state\.windowState\s*\)/;
    expect(source).not.toMatch(subscription);
  });

  it("仍然保留写入方，RoomStage / CompanionPresence 才拿得到这个状态", () => {
    // 摘的是"读"，不是"写"：写的那条 effect 必须在，否则窗口状态整个不再更新。
    expect(source).toContain("setWindowState");
  });
});
