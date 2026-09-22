/**
 * 方案 20 §23.7 — V2 性能 Gate 测量（R35）。
 *
 * 在 production-like 环境（真实 postgres + worker 确定性管道 + 真实网络栈）
 * 测量 §23.7 门槛表：
 *   - createGenerationRunV2 API p95 ≤ 1s
 *   - micro-note 到 review/zero-card p95 ≤ 20s（确定性模式全旅程）
 *   - activation API p95 ≤ 2s
 *   - reveal exposure-first 成功率 = 100%
 *   - PREPARE 成功率 ≥ 99.9%（合法 active target）
 *
 * 方法：N 轮（默认 20）独立 workspace 的 micro-note 全旅程计时，
 * 计算 p50/p90/p95 并对照门槛；LLM 模式相关门槛（provider 调用延迟）
 * 单独采样一次作为参考（平台抖动如实记录，不混入确定性数据）。
 *
 * 运行（从仓库根；需要 worker 可跑确定性管道）：
 *   DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import ./workers/ai-worker/node_modules/tsx/dist/loader.mjs \
 *     workers/ai-worker/src/integration-tests/v2-perf-measure.mjs
 *   （可选）ROUNDS=10 控制轮数；LLM_SAMPLE=1 追加一次真实 LLM 全旅程采样。
 */

import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const ROUNDS = Number(process.env.ROUNDS ?? "20");
const LLM_SAMPLE = process.env.LLM_SAMPLE === "1";

const admin = postgres(ADMIN_URL, { max: 4 });

const CONTENT =
  "机会成本是指为了得到某种东西而必须放弃的其他东西的价值；在决策中，选择某方案就意味着放弃次优方案所能带来的收益。";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(name: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `${name}: n=${samples.length} p50=${percentile(sorted, 50).toFixed(1)}ms ` +
    `p90=${percentile(sorted, 90).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms ` +
    `max=${sorted[sorted.length - 1]?.toFixed(1)}ms`,
  );
}

async function seedNote(content: string) {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const versionId = randomUUID();
  const blockId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${`perf-${userId}@example.invalid`}, 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by) VALUES (${workspaceId}, ${userId}, 'v2-perf', 'v1', now(), ${userId}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by) VALUES (${noteId}, ${workspaceId}, 'perf', ${userId}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by) VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${tx.json({ blocks: [{ type: "paragraph", content }] })}, 'perf-hash', ${userId}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal) VALUES (${blockId}, ${versionId}, ${workspaceId}, 'paragraph', ${content}, 1) ON CONFLICT (id) DO NOTHING`;
  });
  return { workspaceId, userId, versionId };
}

const { createGenerationRunV2 } = await import("../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts");
const { pollV2Outbox } = await import("../handlers/card-generation-v2-handler.ts");

async function runOneRound(): Promise<{ createMs: number; journeyMs: number }> {
  const { workspaceId, userId, versionId } = await seedNote(CONTENT);
  const t0 = performance.now();
  const { runId } = await createGenerationRunV2(
    { workspaceId, userId },
    versionId,
    {
      version: 2,
      noteVersionId: versionId,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
      clientRequestId: `perf-${randomUUID()}`,
    },
    `perf-key-${randomUUID()}`,
  );
  const createMs = performance.now() - t0;

  // 全旅程：poll 直到 run 终态
  const t1 = performance.now();
  for (;;) {
    await pollV2Outbox(10);
    const rows = await admin`SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}`;
    const status = rows[0]?.status;
    if (status && !["queued", "source_sealing", "planning", "authoring", "checking"].includes(status)) {
      break;
    }
    if (performance.now() - t1 > 60_000) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const journeyMs = performance.now() - t1;

  // 清理
  await admin`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = (SELECT note_id FROM note_versions WHERE id = ${versionId})`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${userId}`.catch(() => undefined);
  return { createMs, journeyMs };
}

console.log(`[v2-perf] ROUNDS=${ROUNDS} LLM_SAMPLE=${LLM_SAMPLE}`);
const createSamples: number[] = [];
const journeySamples: number[] = [];
for (let i = 0; i < ROUNDS; i++) {
  const { createMs, journeyMs } = await runOneRound();
  createSamples.push(createMs);
  journeySamples.push(journeyMs);
  console.log(`  round ${i + 1}/${ROUNDS}: create=${createMs.toFixed(0)}ms journey=${journeyMs.toFixed(0)}ms`);
}

console.log("\n=== §23.7 对照（确定性模式，production-like postgres） ===");
summarize("createGenerationRunV2 API", createSamples);
console.log(`  门槛：p95 ≤ 1000ms → ${percentile([...createSamples].sort((a, b) => a - b), 95) <= 1000 ? "✅ 达标" : "❌ 未达标"}`);
summarize("micro-note → review/zero-card 全旅程", journeySamples);
console.log(`  门槛：p95 ≤ 20000ms → ${percentile([...journeySamples].sort((a, b) => a - b), 95) <= 20000 ? "✅ 达标" : "❌ 未达标"}`);
console.log("  说明：journey 含确定性 pipeline（无 provider 网络延迟）；LLM 模式门槛依赖平台，见下方采样");

if (LLM_SAMPLE) {
  console.log("\n=== LLM 模式参考采样（真实 provider，单轮） ===");
  const prevLlm = process.env.CARD_GENERATION_V2_LLM;
  process.env.CARD_GENERATION_V2_LLM = "true";
  process.env.AI_ENDPOINT_RESPONSE_TIMEOUT_MS ??= "600000";
  const t0 = performance.now();
  await runOneRound();
  console.log(`LLM 全旅程（含 provider 调用）：${(performance.now() - t0).toFixed(0)}ms（参考值，平台抖动如实记录）`);
  if (prevLlm === undefined) delete process.env.CARD_GENERATION_V2_LLM;
  else process.env.CARD_GENERATION_V2_LLM = prevLlm;
}

console.log("\n[未测门槛，需 production 环境] activation p95≤2s / reveal 100% / PREPARE ≥99.9% / 首屏交互 p95≤1s —— 见测量报告文档");
await admin.end();
const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
await closeDatabase().catch(() => undefined);
await closeWorkerDatabase().catch(() => undefined);
