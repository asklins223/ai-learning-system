/**
 * pg 模块最小类型声明（node_modules 无 @types/pg；仅 DB 集成测试用）。
 * 生产代码经 drizzle/postgres-js 访问 DB，不直接 import pg。
 */
declare module "pg" {
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  }
  const _default: { Pool: typeof Pool };
  export default _default;
}
