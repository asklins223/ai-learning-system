/**
 * Worker 端共享的 drizzle schema（R35 恢复：R16 起直接引用 apps/api 权威
 * schema——@ailearn/db 镜像会导致 PgTransaction 跨实例类型分裂）。
 */
export * from "../../../../apps/api/src/db/schema/index.ts";
