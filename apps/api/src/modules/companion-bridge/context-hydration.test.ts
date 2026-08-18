/**
 * context-hydration 纯函数测试（文档 16 §14.2）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextSnapshot,
  computeContextRevision,
  entityLookupKey,
} from "./context-hydration.ts";
import type { MainPageContextInputV2 } from "@ailearn/shared";

const uuid = () => crypto.randomUUID();

function makeInput(): MainPageContextInputV2 {
  return {
    routeRef: { kind: "card", cardId: uuid() },
    pageKind: "card",
    entityRefs: [{ kind: "card", cardId: uuid() }, { kind: "key_point", keyPointId: uuid() }],
    interactionState: "idle",
    capabilityHints: ["open_route"],
    sensitivity: "normal",
  };
}

test("computeContextRevision：确定性且对 entityRefs 顺序不敏感", () => {
  const a = makeInput();
  const b = { ...a, entityRefs: [...a.entityRefs].reverse() };
  assert.equal(computeContextRevision(a), computeContextRevision(b));
  assert.ok(computeContextRevision(a).length === 64);
});

test("computeContextRevision：内容变化必产生新 revision", () => {
  const a = makeInput();
  assert.notEqual(
    computeContextRevision(a),
    computeContextRevision({ ...a, interactionState: "formal_answer" }),
  );
  assert.notEqual(
    computeContextRevision(a),
    computeContextRevision({ ...a, entityRefs: [{ kind: "card", cardId: uuid() }] }),
  );
  assert.notEqual(
    computeContextRevision(a),
    computeContextRevision({ ...a, sensitivity: "formal_assessment" }),
  );
});

test("buildContextSnapshot：安全字段来自服务端输入，revision 与输入一致", () => {
  const input = makeInput();
  const now = new Date();
  const snapshot = buildContextSnapshot({
    contextId: "ctx-1",
    accountSessionId: "acct-1",
    deviceSessionId: "dev-1",
    workspaceId: uuid(),
    userId: uuid(),
    pageInstanceId: "page-1",
    input,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 30_000),
  });
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.contextId, "ctx-1");
  assert.equal(snapshot.workspaceId.length > 0, true);
  assert.equal(snapshot.revision, computeContextRevision(input));
  assert.equal(snapshot.expiresAt, new Date(now.getTime() + 30_000).toISOString());
});

test("entityLookupKey：全部 EntityRef kind 有明确映射（V1 卡表退役后 fail soft）", () => {
  const sourceId = uuid();
  assert.deepEqual(entityLookupKey({ kind: "source", sourceId }), { table: "sources", id: sourceId });
  // V1 卡/卡组/要点表已随旧栈退役：card→learning_cards_v2；key_point→objective；
  // card_set 无 V2 等价物 → null（不查询已删表）。
  assert.equal(entityLookupKey({ kind: "card", cardId: uuid() })?.table, "learning_cards_v2");
  assert.equal(entityLookupKey({ kind: "key_point", keyPointId: uuid() })?.table, "learning_objectives_v2");
  assert.equal(entityLookupKey({ kind: "card_set", cardSetId: uuid() }), null);
  assert.equal(entityLookupKey({ kind: "learning_run", runId: uuid() })?.table, "learning_runs");
  assert.equal(entityLookupKey({ kind: "learning_task", runId: uuid(), taskId: uuid() })?.table, "learning_tasks");
  assert.equal(entityLookupKey({ kind: "assistant_session", assistantSessionId: uuid() })?.table, "companion_conversations");
  assert.equal(entityLookupKey({ kind: "route_plan", routePlanId: uuid() })?.table, "understanding_route_plans");
  assert.equal(entityLookupKey({ kind: "change_set", changeSetId: "cs1" })?.table, "understanding_change_sets");
});
