/**
 * Worker 端共享的 drizzle schema。
 *
 * 统一从 apps/api 的 schema 导出（与 worker/src/db.ts 保持一致）——
 * packages/db 镜像包已移除，单一来源为 apps/api/src/db/schema。
 * queue/测试等 import 本模块的文件生成 SQL 的表定义与 db.ts 相同。
 */
export * from "../../../../apps/api/src/db/schema/index.ts";
