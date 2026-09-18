/**
 * Companion dialogue HTTP 边界的 fail-closed 契约。
 *
 * `requireCompanionDialogue` 挂在所有 dialogue 路由（menu-proposals、
 * tool-proposals、learning-context-grants、turns、stream、learning-context …）上：
 * COMPANION_DIALOGUE_V1_ENABLED 未显式等于 "true" 时必须以 404 NOT_FOUND 收口，
 * 否则被禁用的客户端仍能创建持久会话与 turn——这些数据之后永远没有 worker 消费。
 *
 * 此前这条契约没有任何覆盖：集成测试里只有一条断言"环境变量不等于 true"的
 * 同义反复，既不碰 preHandler 也不碰任何产品行为，在 docker-compose.dev.yml
 * 默认开启该 flag 的机器上还会直接失败。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireCompanionDialogue } from "./routes.ts";

/** 最小 FastifyReply 替身：只记录 code()/send() 的调用。 */
function fakeReply(): { reply: FastifyReply; captured: { statusCode?: number; body?: unknown } } {
  const captured: { statusCode?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      captured.statusCode = status;
      return this;
    },
    send(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

const request = {} as FastifyRequest;

function withDialogueFlag(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.COMPANION_DIALOGUE_V1_ENABLED;
  if (value === undefined) delete process.env.COMPANION_DIALOGUE_V1_ENABLED;
  else process.env.COMPANION_DIALOGUE_V1_ENABLED = value;
  return fn().finally(() => {
    if (saved === undefined) delete process.env.COMPANION_DIALOGUE_V1_ENABLED;
    else process.env.COMPANION_DIALOGUE_V1_ENABLED = saved;
  });
}

test("flag 未开启时必须 404 fail closed（未设置/空串/false/非 true 值一律关闭）", async () => {
  for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
    await withDialogueFlag(value, async () => {
      const { reply, captured } = fakeReply();
      await requireCompanionDialogue(request, reply);
      assert.equal(captured.statusCode, 404, `COMPANION_DIALOGUE_V1_ENABLED=${String(value)} 必须 404`);
      const body = captured.body as { error?: string; recoverable?: boolean };
      assert.equal(body.error, "NOT_FOUND", "404 必须是不泄漏存在性的 NOT_FOUND");
      assert.equal(body.recoverable, false);
    });
  }
});

test("flag 显式等于 true 时放行（不写响应）", async () => {
  await withDialogueFlag("true", async () => {
    const { reply, captured } = fakeReply();
    await requireCompanionDialogue(request, reply);
    assert.equal(captured.statusCode, undefined, "flag=true 不得写 404");
    assert.equal(captured.body, undefined);
  });
});
