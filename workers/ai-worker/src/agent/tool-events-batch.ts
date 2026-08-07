import { sql, type SQLWrapper } from "drizzle-orm";

/**
 * P4-3/P4-4: Tool 事件批量幂等写入(实施计划 §5.4)。
 *
 * - 每 Tool Call 独立幂等键(eventKey = tool_request|tool_result:<idempotencyKey>);
 * - 批量 INSERT 多行,onConflictDoNothing 保证幂等(重跑/重启恢复不重复);
 * - 批量不破坏局部恢复:冲突行跳过、其余行照常写入(逐行 onConflict);
 * - Event 顺序稳定:调用方按 turnNo/createdAt 有序构造,批量保持数组顺序。
 *
 * 接受 drizzle db 或事务连接(WorkerTransaction 满足 execute 签名)。
 */

export interface ToolEventRow {
  workspaceId: string;
  runId: string;
  unitId: string | null;
  eventKey: string;
  eventType: "tool_request" | "tool_result";
  agentRole: string;
  turnNo: number;
  toolName: string;
  inputHash: string | null;
  outputHash?: string | null;
  safePayload: Record<string, unknown>;
  errorCode?: string | null;
}

type EventDb = {
  execute: (query: string | SQLWrapper) => PromiseLike<unknown>;
};

/** 批量写入 tool_request 事件(每行独立幂等键) */
export async function persistToolRequestEventsBatch(
  db: EventDb,
  rows: ToolEventRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // 单条 INSERT 多行 + 逐行 ON CONFLICT 幂等
  const values = sql.join(
    rows.map((r) => sql`(
      ${r.workspaceId}, ${r.runId}, ${r.unitId}, ${r.eventKey}, ${r.eventType},
      ${r.agentRole}, ${r.turnNo}, ${r.toolName}, ${r.inputHash}, ${null},
      ${JSON.stringify(r.safePayload)}, ${r.errorCode ?? null}, now()
    )`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO card_generation_agent_events
      (workspace_id, run_id, unit_id, event_key, event_type,
       agent_role, turn_no, tool_name, input_hash, output_hash,
       safe_payload, error_code, created_at)
    VALUES ${values}
    ON CONFLICT (workspace_id, run_id, event_key) DO NOTHING
  `);
  return rows.length;
}

/** 批量写入 tool_result 事件(每行独立幂等键) */
export async function persistToolResultEventsBatch(
  db: EventDb,
  rows: ToolEventRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = sql.join(
    rows.map((r) => sql`(
      ${r.workspaceId}, ${r.runId}, ${r.unitId}, ${r.eventKey}, ${r.eventType},
      ${r.agentRole}, ${r.turnNo}, ${r.toolName}, ${r.inputHash}, ${r.outputHash ?? null},
      ${JSON.stringify(r.safePayload)}, ${r.errorCode ?? null}, now()
    )`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO card_generation_agent_events
      (workspace_id, run_id, unit_id, event_key, event_type,
       agent_role, turn_no, tool_name, input_hash, output_hash,
       safe_payload, error_code, created_at)
    VALUES ${values}
    ON CONFLICT (workspace_id, run_id, event_key) DO NOTHING
  `);
  return rows.length;
}
