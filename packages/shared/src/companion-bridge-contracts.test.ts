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
  COMPANION_PAGE_DESTINATIONS_V2,
  allowedMainRouteV2Schema,
  mainPageContextInputV2Schema,
  navigationCommandEnvelopeV2Schema,
  PAGE_READABLE_TOTAL_CHAR_BUDGET,
  pageReadableV1Schema,
} from "./companion-bridge-contracts.ts";
import { computeContextRevisionV2 } from "./companion-bridge-revision.ts";
import { desktopRouteSchema } from "./desktop-ipc-contracts.ts";

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

/**
 * 页面可读视图（doc 37：伴星通用读页面）。
 *
 * 上限必须是**能失败的**：这一份载荷由页面自己填，任何一页填超了都会被
 * `usePageReadableView` 挡下（不发布 + console 报），而推送那一头的 `.catch`
 * 是吞掉的。所以合同这一层是唯一会真的把形状钉住的地方。
 */

const CONTEXT_BASE = {
  routeRef: { kind: "note", noteId: uuid() },
  pageKind: "note",
  entityRefs: [],
  interactionState: "processing",
  capabilityHints: ["open_route"],
  sensitivity: "normal",
};

const VIEW = {
  pageId: "card_generation_progress",
  title: "把《IndexTTS 2.5》整理成学习卡",
  statusLine: "正在编写候选",
  metrics: [{ label: "进度", value: "已写出 3 / 4 张候选" }],
  items: [
    { ordinal: 1, label: "提取线索", state: "卡型 · 主动回忆" },
    { ordinal: 2, label: "重传触发", state: "卡型 · 机制解释" },
  ],
};

test("pageReadableV1：正常视图通过，且屏上序号与计数原样保留", () => {
  const parsed = pageReadableV1Schema.parse(VIEW);
  assert.deepEqual(parsed.items?.map((item) => item.ordinal), [1, 2]);
  assert.equal(parsed.metrics?.[0].value, "已写出 3 / 4 张候选");
  assert.equal(
    mainPageContextInputV2Schema.parse({ ...CONTEXT_BASE, readableView: VIEW }).readableView?.pageId,
    "card_generation_progress",
  );
});

test("pageReadableV1：条目数、序号起点、标签长度都有上限", () => {
  assert.equal(pageReadableV1Schema.safeParse({ ...VIEW, items: Array.from({ length: 13 }, (_, i) => ({ ordinal: i + 1, label: `第${i}项` })) }).success, false);
  assert.equal(pageReadableV1Schema.safeParse({ ...VIEW, items: [{ ordinal: 0, label: "零号" }] }).success, false);
  assert.equal(pageReadableV1Schema.safeParse({ ...VIEW, items: [{ ordinal: 1, label: "" }] }).success, false);
  assert.equal(pageReadableV1Schema.safeParse({ ...VIEW, metrics: Array.from({ length: 7 }, (_, i) => ({ label: `m${i}`, value: "1" })) }).success, false);
});

test("pageReadableV1：单字段都合规、加起来超总预算也要拒", () => {
  // 12 条各 120 字 + 一句 200 字说明：每一项都合法，加起来 12*120+200+标题等
  // 早已越过 PAGE_READABLE_TOTAL_CHAR_BUDGET。这条是预算闸门的正对照——
  // 只用 12*120 是 1504 字，还在预算内，测不出闸门。
  const fatItems = Array.from({ length: 12 }, (_, index) => ({ ordinal: index + 1, label: "题".repeat(120) }));
  const fat = { ...VIEW, items: fatItems, notice: "说".repeat(200) };
  const used = 12 * 120 + 200 + VIEW.pageId.length + VIEW.title.length
    + (VIEW.statusLine?.length ?? 0) + 2 + 11;
  assert.ok(used > PAGE_READABLE_TOTAL_CHAR_BUDGET, `夹具本身没超预算（${used}）`);
  assert.equal(pageReadableV1Schema.safeParse(fat).success, false);
  const fits = { ...VIEW, items: Array.from({ length: 4 }, (_, index) => ({ ordinal: index + 1, label: "题".repeat(60) })) };
  assert.equal(pageReadableV1Schema.safeParse(fits).success, true);
});

test("pageReadableV1：不接受客户端自报时间，也不接受任何额外字段", () => {
  // "多久之前"只有一个来源（服务端 issued_at）；带时间戳的视图会在每次 publish
  // 都改变内容，把"每推一次就 revoke 一次自己"变成常态。
  assert.equal(pageReadableV1Schema.safeParse({ ...VIEW, generatedAt: new Date().toISOString() }).success, false);
  assert.equal(pageReadableV1Schema.safeParse({ ...VIEW, dom: "<div/>" }).success, false);
  assert.equal(
    mainPageContextInputV2Schema.safeParse({
      ...CONTEXT_BASE,
      readableView: { ...VIEW, items: [{ ordinal: 1, label: "x", answer: "泄题" }] },
    }).success,
    false,
  );
});

test("context revision：可读视图变了就是 context 变了，内容没变则恒定", () => {
  const base = computeContextRevisionV2(mainPageContextInputV2Schema.parse({ ...CONTEXT_BASE, readableView: VIEW }));
  const same = computeContextRevisionV2(mainPageContextInputV2Schema.parse({ ...CONTEXT_BASE, readableView: VIEW }));
  const moved = computeContextRevisionV2(mainPageContextInputV2Schema.parse({
    ...CONTEXT_BASE,
    readableView: { ...VIEW, metrics: [{ label: "进度", value: "已写出 4 / 4 张候选" }] },
  }));
  const none = computeContextRevisionV2(mainPageContextInputV2Schema.parse(CONTEXT_BASE));
  assert.equal(base, same, "同一份视图必须算出同一个 revision");
  assert.notEqual(base, moved, "3/4 变 4/4 必须换 revision");
  assert.notEqual(base, none, "有没有可读视图必须看得出来");
});

test("页面词表：每一页都过得了路由白名单，也都带一个桌面端真有这一 kind 的落点", () => {
  // 这张表是伴星唯一能报得出的页面清单。它坏在哪儿，用户就在哪儿看到"跳错了页"：
  // ① kind 不在白名单里 → 服务端那条 route 会被 runtime 丢掉（nav 块干脆不出现）；
  // ② 落点 kind 桌面端没有 → 「前往」按钮不渲染，她却已经说了"到了"。
  for (const page of COMPANION_PAGE_DESTINATIONS_V2) {
    // 词表是 `as const`，label 与 kind 的字面量类型永不相交，直接比会被 TS 判成
    // 无意义比较；放宽成 string 才留得住这条运行时检查。
    const label: string = page.label;
    const kind: string = page.kind;
    assert.equal(allowedMainRouteV2Schema.safeParse({ kind: page.kind }).success, true, kind);
    assert.equal(desktopRouteSchema.safeParse(page.route).success, true, `${kind} → ${page.route.kind}`);
    assert.ok(label.length > 0 && label !== kind, `${kind} 的中文页名不能就是内部名字`);
  }
  // 正控制：表读到东西了，而不是循环空跑。
  assert.equal(COMPANION_PAGE_DESTINATIONS_V2.length, 10);
});
