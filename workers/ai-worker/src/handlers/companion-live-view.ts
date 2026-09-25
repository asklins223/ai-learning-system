/**
 * 「用户此刻停在哪一屏」的实时行（`assistant_page_contexts`）读取与形状。
 *
 * 抽成叶模块的理由是**只读一次**：`loadHereAndNow` 要拿它渲染"用户正在看…这一屏…"，
 * 实体先行解析（39d W2-3）要拿它的 `items[].ordinal` 落"第 N 张"这种指称。同一份实时行
 * 查两遍就是两个读数，而这两处一旦分叉，她说的"这一屏"和她认出来的"第 3 项"就不是同一
 * 个东西——那种错不会红（渲染层发布失败只是让她读不到）。
 *
 * 顺序与边界（39b §9.6 的判决原文）：**只留实时那条**。`run.page_context` 是
 * `sanitizeContext` 收窄后的**审计字段**，退化为兜底，不再作为"用户在哪一屏"的来源。
 */

import { sql } from "drizzle-orm";
import type { WorkerTransaction } from "../db.ts";

export interface LivePageItem {
  /** 屏幕上显示的那个数（1 起），与 `pageReadableItemV1Schema.ordinal` 同义。 */
  ordinal: number;
  label: string;
  state: string | null;
}

export interface LivePageView {
  /** bridge 的 pageKind 原值（`mainPageContextInputV2Schema` 那 11 档），**不是**中文标签。 */
  pageKind: string;
  /**
   * 同一行的 `interaction_state` 原值（`idle`／`editing`／`formal_answer`／`processing`，
   * 未知值原样带出）。伴星答案暴露的入口条件读它（39d W2-6）：**不在这里读就得往
   * `run.page_context` 里塞**，而那一列由 API 的 `sanitizeContext` 收窄成
   * pageKind/sharing/revision 三个审计字段，多写一个键就会被持久化合同的 `.strict()` 拒掉。
   */
  interactionState: string;
  /**
   * 这一屏是哪一轮学习（`entity_refs` 里 `kind === "learning_run"` 的那条），没有则 null。
   * 暴露账目要记到"用户当时在答的那一题"，不能记到服务端最近一轮上。
   */
  learningRunId: string | null;
  title: string | null;
  statusLine: string | null;
  items: LivePageItem[];
}

function parseItems(view: Record<string, unknown>): LivePageItem[] {
  const raw = Array.isArray(view.items) ? view.items : [];
  const out: LivePageItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const ordinal = Number(item.ordinal);
    if (!Number.isInteger(ordinal) || typeof item.label !== "string") continue;
    out.push({ ordinal, label: item.label, state: typeof item.state === "string" ? item.state : null });
  }
  return out;
}

function parseLearningRunId(entityRefs: unknown): string | null {
  if (!Array.isArray(entityRefs)) return null;
  for (const ref of entityRefs) {
    if (!ref || typeof ref !== "object") continue;
    const record = ref as Record<string, unknown>;
    if (record.kind === "learning_run" && typeof record.runId === "string") return record.runId;
  }
  return null;
}

export async function readLivePageView(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<LivePageView | null> {
  const rows = await tx.execute<{
    page_kind: string;
    readable_view: unknown;
    interaction_state: string;
    entity_refs: unknown;
  }>(sql`
    SELECT page_kind, readable_view, interaction_state, entity_refs
    FROM public.assistant_page_contexts
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    -- 排序键与索引 assistant_page_contexts_workspace_user_idx 的第三列对齐：
    -- 该索引是 (workspace_id, user_id, issued_at)，所以这里按 issued_at 排
    -- （live 行的 updated_at 与 issued_at 几乎同时写下，语义一样）。
    -- 但要说清：实测这个查询**今天仍走 Seq Scan**（4203 行约 1.35 ms），因为该索引
    -- 不含 revoked_at / expires_at 两个过滤列，planner 选了顺扫加排序；代价随表线性长，
    -- 而这张表每 30 秒的页面活动就写一行。真到瓶颈时的正解是加一条部分索引
    -- (workspace_id, user_id, issued_at) WHERE revoked_at IS NULL —— schema 变更、
    -- 要登记 journal，不在本次授权内。别把这段读成「已经走索引了」。
    ORDER BY issued_at DESC, id DESC
    LIMIT 1
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  if (!row) return null;
  const pageKind = String(row.page_kind ?? "");
  if (pageKind.length === 0) return null;
  const view = (row.readable_view && typeof row.readable_view === "object")
    ? row.readable_view as Record<string, unknown>
    : {};
  return {
    pageKind,
    interactionState: String(row.interaction_state ?? ""),
    learningRunId: parseLearningRunId(row.entity_refs),
    title: typeof view.title === "string" ? view.title : null,
    statusLine: typeof view.statusLine === "string" ? view.statusLine : null,
    items: parseItems(view),
  };
}
