/**
 * Bridge context service（文档 16 §14.2）：publish / renew / revoke。
 *
 * 全部在 withWorkspaceTransaction 内执行（RLS 上下文）。publish 逐 EntityRef
 * 校验归属（表存在 + workspace 匹配）；renew 用 expectedRevision CAS；revoke
 * 幂等。跨 workspace / 过期 / 未知实体一律 fail closed。
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { assistantPageContexts } from "@ailearn/shared/db-schema/companion-bridge";
import type {
  AssistantContextSnapshotV2,
  MainPageContextInputV2,
} from "@ailearn/shared";
import {
  buildContextSnapshot,
  computeContextRevision,
  ContextHydrationError,
  CONTEXT_LEASE_SECONDS,
  entityLookupKey,
} from "./context-hydration.ts";

export interface BridgeScope {
  workspaceId: string;
  userId: string;
}

/** P5 已实现的实体表白名单（其余 EntityRef kind 属后续阶段，fail closed）。 */
const HYDRATABLE_TABLES = new Set([
  "sources",
  "notes",
  // 当前卡片与学习卡实体使用 learning_cards_v2 / learning_objectives_v2。
  "learning_cards_v2",
  "learning_objectives_v2",
  "evidence_snapshots_v2",
  "review_schedules",
  "learning_runs",
  "learning_tasks",
  "companion_conversations",
]);

export async function publishContext(
  tx: ApiTransaction,
  scope: BridgeScope,
  input: {
    contextId: string;
    accountSessionId: string;
    deviceSessionId: string;
    pageInstanceId: string;
    page: MainPageContextInputV2;
    now: Date;
  },
): Promise<AssistantContextSnapshotV2> {
  // contextId 是客户端重试的幂等键，也是表的主键。按 id 先加锁，避免
  // 同一个 id 在不同 pageInstance 上并发时把唯一键错误暴露成 500。
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`companion-context-id:${input.contextId}`}, 0))
  `);
  // UPDATE-then-INSERT is not enough here: two publishes for the same page
  // can both revoke the old row and race on the partial unique index.  Keep
  // the whole replace operation serialized for this workspace/user/page.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`companion-context:${scope.workspaceId}:${scope.userId}:${input.pageInstanceId}`}, 0))
  `);
  // R6（round-3 审计）：原实现逐 EntityRef 一条 SELECT 校验（一页 ~8 ref → 8 次
  // 串行 RTT，全程占事务连接）。现按 ref.key.table 分组，每表一条
  // `id = ANY($ids) AND workspace_id = ?` 校验归属，消除 N+1。
  await verifyEntityRefs(tx, scope, input.page.entityRefs ?? []);

  const revision = computeContextRevision(input.page);
  const issuedAt = input.now;
  const expiresAt = new Date(issuedAt.getTime() + CONTEXT_LEASE_SECONDS * 1000);

  const existingRows = await tx
    .select({
      workspaceId: assistantPageContexts.workspaceId,
      userId: assistantPageContexts.userId,
      pageInstanceId: assistantPageContexts.pageInstanceId,
      revision: assistantPageContexts.revision,
      revokedAt: assistantPageContexts.revokedAt,
      issuedAt: assistantPageContexts.issuedAt,
      expiresAt: assistantPageContexts.expiresAt,
    })
    .from(assistantPageContexts)
    .where(eq(assistantPageContexts.id, input.contextId as never))
    .limit(1);
  const existing = existingRows[0];
  if (existing) {
    if (
      existing.workspaceId === scope.workspaceId
      && existing.userId === scope.userId
      && existing.pageInstanceId === input.pageInstanceId
      && existing.revision === revision
      && existing.revokedAt === null
    ) {
      // 同一个 publish 请求重试时返回原 lease，不能先 revoke 再 insert。
      return buildContextSnapshot({
        contextId: input.contextId,
        accountSessionId: input.accountSessionId,
        deviceSessionId: input.deviceSessionId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        pageInstanceId: input.pageInstanceId,
        input: input.page,
        issuedAt: existing.issuedAt,
        expiresAt: existing.expiresAt,
      });
    }
    throw new ContextHydrationError("context id already used", "context_conflict", 409);
  }

  // 同一 (workspace,user,pageInstance) 未撤销 context 唯一：内容变化重新
  // publish 时先撤销旧 context（§14.2：重新 publish 并立即 revoke 旧 context）。
  await tx.update(assistantPageContexts)
    .set({ revokedAt: issuedAt, updatedAt: issuedAt })
    .where(and(
      eq(assistantPageContexts.workspaceId, scope.workspaceId),
      eq(assistantPageContexts.userId, scope.userId),
      eq(assistantPageContexts.pageInstanceId, input.pageInstanceId),
      isNull(assistantPageContexts.revokedAt),
    ));

  await tx.insert(assistantPageContexts).values({
    id: input.contextId as never,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    pageInstanceId: input.pageInstanceId,
    revision,
    routeRef: input.page.routeRef as never,
    pageKind: input.page.pageKind,
    entityRefs: input.page.entityRefs as never,
    interactionState: input.page.interactionState,
    graph: (input.page.graph ?? null) as never,
    capabilityHints: input.page.capabilityHints as never,
    sensitivity: input.page.sensitivity,
    readableView: (input.page.readableView ?? null) as never,
    issuedAt,
    expiresAt,
    createdAt: issuedAt,
    updatedAt: issuedAt,
  });

  return buildContextSnapshot({
    contextId: input.contextId,
    accountSessionId: input.accountSessionId,
    deviceSessionId: input.deviceSessionId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    pageInstanceId: input.pageInstanceId,
    input: input.page,
    issuedAt,
    expiresAt,
  });
}

export async function renewContext(
  tx: ApiTransaction,
  scope: BridgeScope,
  input: { contextId: string; pageInstanceId: string; expectedRevision: string; now: Date },
): Promise<{ revision: string; expiresAt: string } | null> {
  const rows = await tx
    .select()
    .from(assistantPageContexts)
    .where(and(
      eq(assistantPageContexts.id, input.contextId),
      eq(assistantPageContexts.workspaceId, scope.workspaceId),
      eq(assistantPageContexts.userId, scope.userId),
      eq(assistantPageContexts.pageInstanceId, input.pageInstanceId),
      isNull(assistantPageContexts.revokedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.revision !== input.expectedRevision) {
    throw new ContextHydrationError("context revision mismatch");
  }
  const expiresAt = new Date(input.now.getTime() + CONTEXT_LEASE_SECONDS * 1000);
  await tx.update(assistantPageContexts)
    .set({ expiresAt, updatedAt: input.now })
    .where(eq(assistantPageContexts.id, row.id));
  return { revision: row.revision, expiresAt: expiresAt.toISOString() };
}

export async function revokeContext(
  tx: ApiTransaction,
  scope: BridgeScope,
  input: { contextId: string; pageInstanceId: string; expectedRevision: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .select({ id: assistantPageContexts.id, revision: assistantPageContexts.revision })
    .from(assistantPageContexts)
    .where(and(
      eq(assistantPageContexts.id, input.contextId),
      eq(assistantPageContexts.workspaceId, scope.workspaceId),
      eq(assistantPageContexts.userId, scope.userId),
      eq(assistantPageContexts.pageInstanceId, input.pageInstanceId),
      isNull(assistantPageContexts.revokedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (row.revision !== input.expectedRevision) {
    throw new ContextHydrationError("context revision mismatch");
  }
  await tx.update(assistantPageContexts)
    .set({ revokedAt: input.now, updatedAt: input.now })
    .where(eq(assistantPageContexts.id, row.id));
  return true;
}

/** R6：按表分组校验多个 EntityRef 归属（RLS 内；白名单外 fail closed）。 */
async function verifyEntityRefs(
  tx: ApiTransaction,
  scope: BridgeScope,
  refs: NonNullable<MainPageContextInputV2["entityRefs"]>,
): Promise<void> {
  // 先解析并按表分组，随后逐表一条 `id = ANY($ids)` 查询。
  const byTable = new Map<string, { id: string; label: string }[]>();
  for (const ref of refs) {
    const key = entityLookupKey(ref as never);
    if (!key) throw new ContextHydrationError(`unknown entity kind: ${(ref as { kind?: string }).kind}`);
    if (!HYDRATABLE_TABLES.has(key.table)) {
      // companion_journeys / route_plan / change_set 属 P6/P7：出现即拒绝。
      throw new ContextHydrationError(`entity kind not hydratable yet: ${key.table}`);
    }
    let list = byTable.get(key.table);
    if (!list) {
      list = [];
      byTable.set(key.table, list);
    }
    list.push({ id: key.id, label: `${key.table}/${key.id}` });
  }

  await Promise.all([...byTable].map(async ([table, entries]) => {
    // 去重：同一实体多次引用只校验一次（归属对 workspace 一次成立）。
    const ids = [...new Set(entries.map((e) => e.id))];
    // 只做存在性 + workspace 归属校验；不读取实体正文。
    // 表名来自 HYDRATABLE_TABLES 白名单（sql.raw 内插安全）；id 经 zod uuid 校验。
    // 用 ARRAY[$1,$2,...] 展开（而非 `ANY(${array})`）：postgres.js 对**单元素** JS 数组
    // 会折叠为标量字符串参数（报“malformed array literal”），ARRAY[...] 逐参绑定恒稳定；
    // 每个 id 走独立绑定位（无注入风险）。
    // 2026-08-23 修复：V2 表的业务键与代理主键分离（learning_cards_v2.card_id /
    // learning_objectives_v2.objective_id），EntityRef 携带的是业务键——按表选择
    // 查找列，其余表仍用 id。
    const idColumn = table === "learning_cards_v2" ? "card_id"
      : table === "learning_objectives_v2" ? "objective_id"
      : table === "evidence_snapshots_v2" ? "evidence_snapshot_id"
      : "id";
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await tx.execute(sql`
      SELECT ${sql.raw(idColumn)} AS id FROM ${sql.raw(table)}
      WHERE workspace_id = ${scope.workspaceId} AND ${sql.raw(idColumn)} = ANY(ARRAY[${idList}])
    `);
    const found = new Set(
      (rows as unknown as Array<Record<string, unknown>>).map((r) => String(r.id)),
    );
    const missing = entries.filter((e) => !found.has(e.id)).map((e) => e.label);
    if (missing.length > 0) {
      throw new ContextHydrationError(`entity not found in workspace: ${missing.join(",")}`);
    }
  }));
}
