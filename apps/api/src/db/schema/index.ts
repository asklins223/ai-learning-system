/**
 * 兼容 re-export（2026-08-24 AI 设计审查 §4.4 第三批）。
 *
 * Drizzle schema 单一事实来源已下沉至 packages/shared/src/db-schema/
 * （api 与 worker 平级消费）。新代码请直接引用 @ailearn/shared/db-schema；
 * 本路径仅为既有 81 处 api 内部导入保留。
 */
export * from "@ailearn/shared/db-schema";
