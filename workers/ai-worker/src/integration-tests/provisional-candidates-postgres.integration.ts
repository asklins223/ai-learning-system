/**
 * P2-6：provisional_candidates 升级流程集成测试(真实 postgres)。
 *
 * 覆盖:写入(通过校验的 Fast 候选)、pending 读取、决策应用(confirm/revise/reject)、
 * 审计字段(producedByUnitId 保留)。
 *
 * 运行:
 *   CARD_GENERATION_TEST_ADMIN_URL=<admin-url> DATABASE_URL=<worker-url> \
 *     node --import tsx --test src/integration-tests/provisional-candidates-postgres.integration.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import {
  writeProvisionalCandidates,
  listPendingProvisionalCandidates,
  applyProvisionalDecision,
  countPendingProvisionalCandidates,
} from "../agent/provisional-candidates.ts";
import type { FastExtractionArtifact } from "@ailearn/shared";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");
const admin = postgres(adminUrl, { max: 4 });

const RUN_ID = "50000000-0000-4000-8000-000000000041";
const WS_ID = "20000000-0000-4000-8000-000000000041";
const USER_ID = "10000000-0000-4000-8000-000000000041";
const NOTE_ID = "30000000-0000-4000-8000-000000000041";
const VERSION_ID = "40000000-0000-4000-8000-000000000041";
const UNIT_ID = "60000000-0000-4000-8000-000000000041";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

async function seedRun(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM provisional_candidates WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${RUN_ID}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p2-6@example.invalid', 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WS_ID}, ${USER_ID}, 'p2-6', 'v1', now(), ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WS_ID}, 't', ${USER_ID}, 1) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WS_ID}, 1, '{}'::jsonb, 'h', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units
      ) VALUES (
        ${RUN_ID}, ${WS_ID}, ${NOTE_ID}, ${VERSION_ID}, ${USER_ID},
        'p2-6-e2e', 'p2-6-fp', 1, 't', 'h', 'bh', 'ah',
        '[]'::jsonb, '[]'::jsonb, 'running', 'queued', 1, 1, true, 1
      ) ON CONFLICT (id) DO NOTHING`;
  });
}

function artifact(): FastExtractionArtifact {
  return {
    documentIntent: "intent",
    learningFocus: ["focus"],
    candidates: [
      { localId: "c1", claim: "命题一", topic: "t1", sectionKey: "1", cognitiveType: "concept", importance: "core", difficulty: "basic", evidenceRefIds: ["ev-1"] },
      { localId: "c2", claim: "命题二", topic: "t2", sectionKey: "2", cognitiveType: "code", importance: "core", difficulty: "intermediate", evidenceRefIds: ["ev-2"], relationHints: [{ type: "supports", localTargetId: "c1" }] },
    ],
    noCandidateDecisions: [],
  };
}

test("P2-6: 写入 → pending 读取 → 决策应用(confirm/revise/reject),producedBy 保留", async () => {
  await seedRun();

  const written = await writeProvisionalCandidates({
    workspaceId: WS_ID,
    runId: RUN_ID,
    producedByUnitId: UNIT_ID,
    artifact: artifact(),
    sourceProviderCallId: "provider-call-1",
  });
  assert.equal(written, 2, "写入 2 个候选");

  const pending = await listPendingProvisionalCandidates(RUN_ID);
  assert.equal(pending.length, 2);
  const c1 = pending.find((p) => p.localId === "c1")!;
  assert.equal(c1.claim, "命题一");
  assert.deepEqual(c1.evidenceRefIds, ["ev-1"]);
  assert.equal(c1.decision, null, "初始待确认");

  // producedBy 审计 + relationHints:直接查 DB(postgres.js 已解析 jsonb)
  const [row] = await admin<{ produced_by_unit_id: string; relation_hints: Array<{ type: string; localTargetId: string }> }[]>`
    SELECT produced_by_unit_id, relation_hints FROM provisional_candidates
    WHERE run_id = ${RUN_ID} AND local_id = 'c2'`;
  assert.equal(row?.produced_by_unit_id, UNIT_ID, "producedBy 保留");
  assert.deepEqual(row?.relation_hints, [{ type: "supports", localTargetId: "c1" }]);

  // 决策应用:confirm c1、revise c2
  const applied = await applyProvisionalDecision({
    workspaceId: WS_ID,
    runId: RUN_ID,
    decisionByUnitId: UNIT_ID,
    decisions: [
      { candidateId: c1.id, decision: "confirm" },
      { candidateId: pending.find((p) => p.localId === "c2")!.id, decision: "revise", revisedClaim: "修订后命题二" },
    ],
  });
  assert.equal(applied, 2);

  const after = await listPendingProvisionalCandidates(RUN_ID);
  const a1 = after.find((p) => p.localId === "c1")!;
  const a2 = after.find((p) => p.localId === "c2")!;
  assert.equal(a1.decision, "confirm");
  assert.equal(a2.decision, "revise");
  assert.equal(a2.revisedClaim, "修订后命题二");

  // reject 后 pending 计数(decision=confirm 不再 pending;reject 也终态)
  await applyProvisionalDecision({
    workspaceId: WS_ID,
    runId: RUN_ID,
    decisionByUnitId: UNIT_ID,
    decisions: [{ candidateId: a1.id, decision: "reject" }],
  });
  // countPending 只算 null/revise/supplement → confirm/reject 后为 0(revise 的 c2 仍算 pending)
  const pendingCount = await countPendingProvisionalCandidates(RUN_ID);
  assert.equal(pendingCount, 1, "仅 revise 的 c2 仍算 pending");
});
