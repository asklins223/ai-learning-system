import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCompanionTurn, CompanionConversationError } from "./turn-service.ts";
import { WorkspaceTransactionContextError } from "../../db/client.ts";

function validBody() {
  return {
    version: 1,
    clientMessageId: randomUUID(),
    inputKind: "text",
    blocks: [{ type: "text", text: "你好" }],
    sourceSurface: "pet",
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof CompanionConversationError && err.code === code,
  );
}

test("非法 body（缺 clientMessageId）→ INVALID_REQUEST 400（DB 前校验）", async () => {
  const body = validBody();
  delete (body as { clientMessageId?: string }).clientMessageId;
  await expectCode(
    createCompanionTurn({ workspaceId: randomUUID(), userId: randomUUID(), conversationId: randomUUID(), idempotencyKey: randomUUID(), body }),
    "INVALID_REQUEST",
  );
});

test("非法 block 类型 → INVALID_REQUEST 400", async () => {
  const body = { ...validBody(), blocks: [{ type: "image" }] };
  await expectCode(
    createCompanionTurn({ workspaceId: randomUUID(), userId: randomUUID(), conversationId: randomUUID(), idempotencyKey: randomUUID(), body }),
    "INVALID_REQUEST",
  );
});

test("文本超硬限额 → INVALID_REQUEST 400", async () => {
  const body = { ...validBody(), blocks: [{ type: "text", text: "x".repeat(20001) }] };
  await expectCode(
    createCompanionTurn({ workspaceId: randomUUID(), userId: randomUUID(), conversationId: randomUUID(), idempotencyKey: randomUUID(), body }),
    "INVALID_REQUEST",
  );
});

test("非 UUID workspaceId → WorkspaceTransactionContextError（RLS context 校验）", async () => {
  await assert.rejects(
    createCompanionTurn({ workspaceId: "not-a-uuid", userId: randomUUID(), conversationId: randomUUID(), idempotencyKey: randomUUID(), body: validBody() }),
    (err: unknown) => err instanceof WorkspaceTransactionContextError,
  );
});
