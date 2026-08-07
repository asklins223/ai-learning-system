/**
 * P2-6：Fast → Full 升级流程（实施计划 §3.3, P2-6）。
 *
 * 1. 通过校验的 FastExtractionArtifact 写入 provisional_candidates(producedBy 保留);
 * 2. Full Supervisor 读取 provisional 候选,执行 confirm / revise / reject / supplement;
 * 3. 升级**不重置 repairCount**(run 级预算与自旋检测兜底,§9-1);
 * 4. 失败 Artifact(未通过校验)不写入、不发布。
 *
 * P2-1 只统计不切换:本模块为独立组件,Router 未路由前不被调用。
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import type { FastExtractionArtifact, FastExtractionCandidate } from "@ailearn/shared";

export type ProvisionalDecision = "confirm" | "revise" | "reject" | "supplement";

export interface WriteProvisionalInput {
  workspaceId: string;
  runId: string;
  producedByUnitId: string;
  artifact: FastExtractionArtifact;
  sourceProviderCallId?: string;
}

export interface ProvisionalCandidateRow {
  id: string;
  localId: string;
  claim: string;
  topic: string;
  sectionKey: string;
  cognitiveType: string;
  importance: string;
  difficulty: string;
  evidenceRefIds: string[];
  relationHints: Array<{ type: string; localTargetId: string }>;
  decision: string | null;
  revisedClaim: string | null;
}

/** 写入通过校验的 Fast 候选(失败 Artifact 不写入) */
export async function writeProvisionalCandidates(input: WriteProvisionalInput): Promise<number> {
  const { workspaceId, runId, producedByUnitId, artifact, sourceProviderCallId } = input;
  const rows = artifact.candidates.map((c: FastExtractionCandidate) => ({
    workspaceId,
    runId,
    producedByUnitId,
    localId: c.localId,
    claim: c.claim,
    topic: c.topic,
    sectionKey: c.sectionKey,
    cognitiveType: c.cognitiveType,
    importance: c.importance,
    difficulty: c.difficulty,
    evidenceRefIds: c.evidenceRefIds,
    relationHints: c.relationHints ?? [],
    sourceProviderCallId: sourceProviderCallId ?? null,
  }));

  if (rows.length === 0) return 0;

  // 幂等约束已由 UNIQUE(run_id, local_id) 保障(§4.1 Tool 幂等无回归),
  // onConflictDoNothing 防重复插入,重跑/重启恢复安全。
  const inserted = await db
    .insert(schema.provisionalCandidates)
    .values(rows as never[])
    .onConflictDoNothing()
    .returning({ id: schema.provisionalCandidates.id });

  logger.info({ runId, count: inserted.length }, "P2-6: provisional candidates 已写入");
  return inserted.length;
}

/** 读取 run 的全部 provisional 候选(含已决策行,供 Full 审计/继续处理) */
export async function listProvisionalCandidates(runId: string): Promise<ProvisionalCandidateRow[]> {
  const rows = await db
    .select()
    .from(schema.provisionalCandidates)
    .where(and(
      eq(schema.provisionalCandidates.runId, runId),
    ));

  return rows.map((r) => ({
    id: r.id,
    localId: r.localId,
    claim: r.claim,
    topic: r.topic,
    sectionKey: r.sectionKey,
    cognitiveType: r.cognitiveType,
    importance: r.importance,
    difficulty: r.difficulty,
    evidenceRefIds: (r.evidenceRefIds ?? []) as string[],
    relationHints: (r.relationHints ?? []) as Array<{ type: string; localTargetId: string }>,
    decision: r.decision,
    revisedClaim: r.revisedClaim,
  }));
}

/** 应用 Full Supervisor 决策(confirm/revise/reject/supplement) */
export async function applyProvisionalDecision(input: {
  workspaceId: string;
  runId: string;
  decisionByUnitId: string;
  decisions: Array<{ candidateId: string; decision: ProvisionalDecision; revisedClaim?: string }>;
}): Promise<number> {
  const { workspaceId, runId, decisionByUnitId, decisions } = input;
  let applied = 0;
  const VALID_DECISIONS: readonly ProvisionalDecision[] = ["confirm", "revise", "reject", "supplement"];
  for (const d of decisions) {
    // security LOW 建议:运行时枚举强校验(decision 列无 DB CHECK,防任意字符串写入)
    if (!VALID_DECISIONS.includes(d.decision)) {
      logger.warn({ runId, decision: d.decision }, "P2-6: 非法 provisional 决策,跳过");
      continue;
    }
    const set = {
      decision: d.decision,
      decisionByUnitId,
      decisionAt: new Date(),
      ...(d.revisedClaim != null ? { revisedClaim: d.revisedClaim } : {}),
    };
    const [row] = await db
      .update(schema.provisionalCandidates)
      .set(set as never)
      .where(and(
        eq(schema.provisionalCandidates.id, d.candidateId),
        eq(schema.provisionalCandidates.workspaceId, workspaceId),
        eq(schema.provisionalCandidates.runId, runId),
      ))
      .returning({ id: schema.provisionalCandidates.id });
    if (row) applied += 1;
  }
  logger.info({ runId, applied }, "P2-6: provisional 决策已应用");
  return applied;
}

/** 待确认候选数(供升级流程/测试) */
export async function countPendingProvisionalCandidates(runId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.provisionalCandidates.id })
    .from(schema.provisionalCandidates)
    .where(and(
      eq(schema.provisionalCandidates.runId, runId),
      inArray(schema.provisionalCandidates.decision, [null, "revise", "supplement"] as never),
    ));
  return rows.length;
}
