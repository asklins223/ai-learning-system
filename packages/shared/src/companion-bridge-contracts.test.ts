/**
 * Main ↔ Pet Bridge V2 合同 strict/negative 测试（文档 16 §14）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantDeliveryV2Schema,
  companionSystemEventV2Schema,
  inPageCommandEnvelopeV2Schema,
  mainCommandResultV2Schema,
  mainPageContextInputV2Schema,
  navigationCommandEnvelopeV2Schema,
} from "./companion-bridge-contracts.ts";

const uuid = () => crypto.randomUUID();

test("mainPageContextInputV2Schema：renderer 只提交非安全字段，安全字段被拒绝", () => {
  const ok = {
    routeRef: { kind: "card", cardId: uuid(), objectiveId: uuid() },
    pageKind: "card",
    entityRefs: [{ kind: "card", cardId: uuid() }, { kind: "key_point", keyPointId: uuid() }],
    interactionState: "idle",
    capabilityHints: ["open_route"],
    sensitivity: "normal",
  };
  assert.equal(mainPageContextInputV2Schema.parse(ok).pageKind, "card");
  // renderer 不得自报 account/workspace/user/pageInstance（broker 覆盖）。
  assert.equal(
    mainPageContextInputV2Schema.safeParse({
      ...ok,
      workspaceId: uuid(),
      userId: uuid(),
      pageInstanceId: "self-reported",
      revision: "self-reported",
    }).success,
    false,
  );
  // 未知字段拒绝
  assert.equal(mainPageContextInputV2Schema.safeParse({ ...ok, dom: "leak" }).success, false);
  // 非法 interactionState
  assert.equal(mainPageContextInputV2Schema.safeParse({ ...ok, interactionState: "typing" }).success, false);
});

test("mainPageContextInputV2Schema：graph checkpoint 使用 opaque token（opaque 传输校验）", () => {
  const ok = {
    routeRef: { kind: "star_map" },
    pageKind: "star_map",
    entityRefs: [],
    interactionState: "idle",
    graph: {
      lens: "current_target",
      selectedKeyPointId: uuid(),
      activeRoutePlanId: null,
      checkpoint: {
        version: 1,
        workspaceId: uuid(),
        userId: uuid(),
        token: "opaque-token",
        capturedAt: new Date().toISOString(),
      },
    },
    capabilityHints: ["graph.focus"],
    sensitivity: "normal",
  };
  const parsed = mainPageContextInputV2Schema.parse(ok);
  assert.equal(parsed.graph?.checkpoint.token, "opaque-token");
});

test("companionSystemEventV2Schema：事件 source/eventType/payloadRef 严格判别", () => {
  const ok = {
    version: 2,
    eventId: "e1",
    sequence: 1,
    source: "learning_run",
    workspaceId: uuid(),
    userId: uuid(),
    eventType: "learning_run.completed",
    occurredAt: new Date().toISOString(),
    payloadRef: { kind: "learning_run", runId: uuid(), eventCursor: 4 },
  };
  assert.equal(companionSystemEventV2Schema.parse(ok).eventType, "learning_run.completed");
  assert.equal(companionSystemEventV2Schema.safeParse({ ...ok, source: "chat" }).success, false);
  assert.equal(
    companionSystemEventV2Schema.safeParse({
      ...ok,
      eventType: "review.due",
      payloadRef: { kind: "learning_run", runId: uuid(), eventCursor: 1 },
    }).success,
    true, // payloadRef 与 eventType 的语义绑定由 Orchestrator 校验，schema 只保证形状
  );
});

test("assistantDeliveryV2Schema：display lease 唯一性形状、状态枚举严格", () => {
  const ok = {
    version: 2,
    deliveryId: "d1",
    assistantSessionId: uuid(),
    userId: uuid(),
    workspaceId: uuid(),
    inboxSequence: 3,
    dedupeKey: "k",
    state: "queued",
    kind: "proposal",
    payloadRef: { kind: "proposal", proposalId: uuid() },
    displayLease: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  };
  assert.equal(assistantDeliveryV2Schema.parse(ok).state, "queued");
  assert.equal(assistantDeliveryV2Schema.safeParse({ ...ok, state: "read" }).success, false);
  assert.equal(
    assistantDeliveryV2Schema.parse({
      ...ok,
      displayLease: { deviceSessionId: "dev1", leaseToken: "t", expiresAt: new Date().toISOString() },
    }).displayLease?.deviceSessionId,
    "dev1",
  );
});

test("navigationCommandEnvelopeV2Schema：navigation 只允许 open_route", () => {
  const ok = {
    version: 2,
    scope: "navigation",
    commandId: "c1",
    expiresAt: new Date().toISOString(),
    command: { kind: "open_route", route: { kind: "review" } },
  };
  assert.equal(navigationCommandEnvelopeV2Schema.parse(ok).command.kind, "open_route");
  assert.equal(
    navigationCommandEnvelopeV2Schema.safeParse({
      ...ok,
      command: { kind: "graph.restore", runId: uuid() },
    }).success,
    false,
  );
});

test("inPageCommandEnvelopeV2Schema：页内命令强制 freshness 字段，且不接受 open_route", () => {
  const ok = {
    version: 2,
    scope: "in_page",
    commandId: "c2",
    targetPageInstanceId: "p1",
    expectedContextRevision: "rev1",
    expiresAt: new Date().toISOString(),
    command: { kind: "graph.focus", keyPointId: uuid() },
  };
  assert.equal(inPageCommandEnvelopeV2Schema.parse(ok).command.kind, "graph.focus");
  // 缺 expectedContextRevision → 拒绝
  const { expectedContextRevision: _drop, ...missing } = ok;
  assert.equal(inPageCommandEnvelopeV2Schema.safeParse(missing).success, false);
  // open_route 不能作为页内命令
  assert.equal(
    inPageCommandEnvelopeV2Schema.safeParse({
      ...ok,
      command: { kind: "open_route", route: { kind: "today" } },
    }).success,
    false,
  );
});

test("mainCommandResultV2Schema：reasonCode 枚举与 resultRefs 严格", () => {
  const ok = {
    version: 2,
    commandId: "c1",
    status: "completed",
    resultRefs: [{ kind: "card", cardId: uuid() }],
    occurredAt: new Date().toISOString(),
  };
  assert.equal(mainCommandResultV2Schema.parse(ok).status, "completed");
  assert.equal(
    mainCommandResultV2Schema.safeParse({ ...ok, reasonCode: "unknown_code" }).success,
    false,
  );
});
