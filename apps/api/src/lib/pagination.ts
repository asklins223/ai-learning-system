/**
 * F-024/R-019/R-022: 统一分页参数与校验工具。
 *
 * 无 Fastify 依赖的纯工具位于 ./pagination-utils.ts，可被 worker 等非 API
 * 包安全引用；本文件额外提供 Fastify 路由用的 parseQuery。
 */
export {
  clampLimit,
  clampOffset,
  clampPagination,
  encodeCursor,
  decodeCursor,
  paginationQuerySchema,
  uuidParamSchema,
  cardIdParamSchema,
} from "./pagination-utils.ts";

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeAny } from "zod";

type FastifyInstanceWithHttpErrors = FastifyInstance & {
  httpErrors: {
    badRequest(message: string): Error;
  };
};

/**
 * R-022: 统一解析 query 参数，校验失败时抛 400。
 * 使用方式：const q = parseQuery(app, paginationQuerySchema, req.query);
 */
export function parseQuery<S extends ZodTypeAny>(app: FastifyInstance, schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw (app as FastifyInstanceWithHttpErrors).httpErrors.badRequest(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data as z.output<S>;
}
