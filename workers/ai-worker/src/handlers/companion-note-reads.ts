/**
 * 笔记级的两个读数，供**环境块**（《X》那一行）与**事实块**（裸标题/这一屏那一项）共用：
 *
 *   1. `findNearestNoteTitle` —— "最接近的一篇"（39b §9.3 第二行）；
 *   2. `findNoteRuns` —— "这篇有 N 轮在暂停／进行中"（`start`/`resume` 的服务端回填，
 *      39b §9.8 的 C1）。
 *
 * 为什么是叶子模块：两个消费者在依赖上互不相识（环境块在本文件之外、事实块 import 它），
 * 谁能 import 谁不能，取决于这里放什么；放在叶子上一劳永逸。
 *
 * 标题相似度（"最接近的一篇"那一行的判据，39b §9.3 第二行）。
 *
 * 为什么不用 pg_trgm 的相似度函数或编辑距离：这一行只是"给她一个更接近的真对象"的提示，
 * 不是判决；两字滑窗在中文标题上够用，且完全确定性、可复算、不发额外查询。
 * （那段函数名刻意不写出来：`apps/api/src/__tests__/memory-similarity-threshold.test.ts`
 * 按函数名扫描 api + worker 的源码，写在注释里也会被当成第二个调用点。）
 *
 * 独立成一个叶子模块是为了让 `companion-here-and-now`（《X》未命中那行）与
 * `companion-this-turn-facts`（裸标题未命中那行）共用同一份判据——两处各写一份，
 * 同一句"最接近的是《Y》"迟早有两个答案。
 */

import { sql } from "drizzle-orm";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";
import type { WorkerTransaction } from "../db.ts";

/** 候选池：最近更新的 N 篇可见笔记。够用且恒定，不为它开窗口函数。 */
const NEAREST_CANDIDATE_LIMIT = 60;

function bigrams(text: string): string[] {
  const chars = Array.from(text.replace(/\s+/g, ""));
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return chars.length === 1 ? chars : out;
}

/** 指称文字与标题的两字窗重合度（0–1）。 */
export function titleSimilarity(referent: string, title: string): number {
  const ref = new Set(bigrams(referent));
  if (ref.size === 0) return 0;
  const candidate = new Set(bigrams(title));
  let hit = 0;
  for (const gram of ref) if (candidate.has(gram)) hit += 1;
  return hit / ref.size;
}

export async function findNearestNoteTitle(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  referent: string,
): Promise<{ title: string; score: number } | null> {
  const rows = await tx.execute<{ title: string }>(sql`
    SELECT n.title FROM notes n
    WHERE n.workspace_id = ${scope.workspaceId} AND n.deleted_at IS NULL
      AND ${sql.raw(noteVisibleSqlText("n", `'${scope.userId}'::uuid`))}
    ORDER BY n.updated_at DESC LIMIT ${NEAREST_CANDIDATE_LIMIT}
  `);
  let best: { title: string; score: number } | null = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const score = titleSimilarity(referent, row.title);
    if (score > 0 && (!best || score > best.score)) best = { title: row.title, score };
  }
  return best;
}

/** 一篇笔记正在进行的轮次（"这篇有 N 轮在暂停／进行中"这句回填的来源）。 */
export interface NoteRunRow extends Record<string, unknown> {
  id: string;
  phase: string;
  note_id: string;
}

const ACTIVE_RUN_PHASES = ["preparing", "active", "assessing", "checkpoint", "committing", "paused"] as const;

/**
 * 这篇笔记上有哪些轮次还没结束——按"目标有 origin 指向这篇笔记"关联。
 *
 * 为什么经 `learning_objective_origins_v2` 而不是 `learning_runs.origin`：后者是 jsonb
 * 的 **return_target**（哪张卡/哪个目标），没有 note 这一维；而 origin 表是"目标从哪篇
 * 笔记来"的正规记录。代价是覆盖率低（39d §18.1：208 个 objective 只有 22 个有 origin 行）
 * ——这是数据的现状，不是判据的问题：没有 origin 就没有"这篇"这个说法，宁可不回填。
 */
export async function findNoteRuns(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  noteIds: string[],
): Promise<Map<string, NoteRunRow[]>> {
  const grouped = new Map<string, NoteRunRow[]>();
  if (noteIds.length === 0) return grouped;
  const idList = sql.join(noteIds.map((id) => sql`${id}::uuid`), sql`, `);
  const phaseList = sql.join(ACTIVE_RUN_PHASES.map((phase) => sql`${phase}`), sql`, `);
  const rows = await tx.execute<NoteRunRow>(sql`
    SELECT r.id, r.phase, o.note_id
    FROM learning_runs r
    JOIN learning_objective_origins_v2 o
      ON o.workspace_id = r.workspace_id AND o.note_id IN (${idList})
     AND EXISTS (
       SELECT 1 FROM learning_target_snapshots_v2 s
       WHERE s.run_id = r.id AND s.workspace_id = r.workspace_id
         AND s.objective_id = o.objective_id
     )
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      AND r.phase IN (${phaseList})
    ORDER BY r.updated_at DESC LIMIT 12
  `);
  for (const row of Array.isArray(rows) ? rows : []) {
    const list = grouped.get(String(row.note_id)) ?? [];
    list.push({ ...row, note_id: String(row.note_id) });
    grouped.set(String(row.note_id), list);
  }
  return grouped;
}
