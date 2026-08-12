/**
 * vitest jsdom 环境补丁：补 Next/浏览器 API 缺省。
 * 只加 jsdom 缺失的最小集合——测试需要什么补什么。
 */

// jsdom 未实现 matchMedia（ThemeProvider / useMediaQuery 依赖）。
// 恒 matches:true（reduced-motion）——组件动画走同步路径，测试可确定性断言。
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom 未实现 scrollTo / requestAnimationFrame 已有(modern jsdom 提供 rAF)
if (typeof window !== "undefined" && typeof window.scrollTo !== "function") {
  window.scrollTo = () => undefined;
}

// RTL 渲染后自动清理 DOM(否则测试间元素残留导致 getByTestId 重复命中)
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => {
  cleanup();
});
