/**
 * Worker 端共享的 drizzle schema。
 *
 * 2026-08-24（AI 设计审查 §4.4 第三批）：单一事实来源为
 * packages/shared/src/db-schema——worker 与 api 平级消费，本路径保留兼容
 * re-export（queue/测试等既有导入不变）。
 */
export * from "@ailearn/shared/db-schema";
