import type { FastifyInstance } from "fastify";
import type { z, ZodTypeAny } from "zod";

/**
 * 解析请求体，失败时抛 400（经 @fastify/sensible 序列化）。
 * 返回 schema 的 *output* 类型（.default() 等已生效）。
 * 用法：const body = parseBody(app, noteCreateSchema, req.body);
 */
export function parseBody<S extends ZodTypeAny>(app: FastifyInstance, schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw app.httpErrors.badRequest(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data as z.output<S>;
}
