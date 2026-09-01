/**
 * Drizzle 数据库 Schema（单一事实来源）。
 *
 * 2026-08-24（AI 设计审查 §4.4 第三批）：自 apps/api/src/db/schema 下沉至
 * packages/shared——schema 目录本就自包含（仅依赖 drizzle-orm 与
 * @ailearn/shared 的 type），下沉后 api 与 worker 成为平级消费者，worker 内
 * 对 apps/api 的最后一类反向路径依赖（drizzle 表定义）消除。
 *
 * 配套：
 * - drizzle-kit（apps/api/drizzle.config.ts）的 schema 路径指向本目录；
 * - apps/api/src/db/schema 保留兼容 re-export 壳（81 处 api 内部导入不变）；
 * - CI verify-schema-mirror 检查同步改为校验 canonical 目录为本路径。
 */

export * from "./enums.ts";
export * from "./identity.ts";
export * from "./session.ts";
export * from "./note.ts";
export * from "./evidence.ts";
export * from "./ai.ts";
export * from "./job.ts";
export * from "./search.ts";
export * from "./validation-v2.ts";
export * from "./card-generation-v2.ts";
export * from "./learning-sessions.ts";
export * from "./learning-runs.ts";
export * from "./companion-bridge.ts";
export * from "./companion-journey.ts";
export * from "./understanding-projection.ts";
export * from "./companion-sandbox.ts";
export * from "./assistant-deliveries.ts";
export * from "./assistant-memory.ts";
export * from "./companion-memory.ts";
export * from "./companion.ts";
export * from "./companion-conversations.ts";
export * from "./learning-exposure.ts";
export * from "./outbox.ts";
export * from "./learning-metrics.ts";
