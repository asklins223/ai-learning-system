/**
 * Worker 端共享的 drizzle schema。
 *
 * 统一从 apps/api 的 schema 导出（与 worker/src/db.ts 保持一致）——此前经
 * @ailearn/db（packages/db）导入，与 db.ts 使用的 apps/api schema 形成
 * 双份实例：两个 drizzle-orm 包身份（apps/api/node_modules 与
 * packages/db/node_modules）导致 PgTransaction/PgTable 类型互不兼容，
 * 全仓 typecheck 2125 个错误（第四轮遗留项修复）。统一单一来源后类型
 * 一致；queue/测试等 import 本模块的文件生成 SQL 的表定义与 db.ts 相同。
 */
export * from "../../../../apps/api/src/db/schema/index.ts";
