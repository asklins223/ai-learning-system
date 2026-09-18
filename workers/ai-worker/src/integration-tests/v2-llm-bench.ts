/**
 * V2 学习卡生成 —— **真实 LLM** 端到端链路耗时基准（2026-09-17 并发改造前后对比用）。
 *
 * 与 `v2-perf-measure.ts` 的分工：那个脚本测确定性管道的 §23.7 门槛（无 provider
 * 网络延迟）；本脚本跑真实 provider，并从 worker 容器日志里取每一次
 * `[v2-llm] chatJson response` 的 elapsedMs，因此能同时回答两个问题：
 *
 *   1. 端到端墙钟有多长（run 创建 → 终态）；
 *   2. 墙钟是否 ≈ 各次 LLM 调用耗时之和（串行）还是 ≈ 最慢的那一批（并发）。
 *
 * 第 2 点是本次改造的核心证据：`sumLlmMs / wallMs` 越接近 1 说明调用几乎完全串行，
 * 越接近 0 说明重叠度越高。provider 侧单调用耗时在改造前后不变，因此这个比值
 * 直接量化了"并发"带来的收益，而不受模型当日快慢的影响。
 *
 * 运行（仓库根）：
 *   DATABASE_URL_API=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs \
 *     workers/ai-worker/src/integration-tests/v2-llm-bench.ts
 *
 * 环境变量：
 *   ROUNDS=3                    轮数（每轮独立 workspace + note，互不干扰）
 *   NOTE_VARIANT=multi|small    笔记内容（默认 multi：5 个概念）
 *   BENCH_LABEL=before|after    结果标签
 *   BENCH_WORKER_CONTAINER      worker 容器名；置空则跳过逐调用耗时统计
 *   BENCH_OUT=/path/result.json 额外落一份 JSON 结果
 *
 * 注意：本脚本**不**自己认领 outbox job——run 由正在运行的 worker 容器消费，
 * 这正是要测的真实链路（含 outbox 认领延迟）。
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { median, parseChatJsonCalls, percentile, type LlmCall } from "./v2-llm-bench-lib.ts";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;
process.env.DATABASE_URL_WORKER ??= ADMIN_URL;

const ROUNDS = Number(process.env.ROUNDS ?? "3");
const LABEL = process.env.BENCH_LABEL ?? "run";
const VARIANT = process.env.NOTE_VARIANT ?? "multi";
const CONTAINER = process.env.BENCH_WORKER_CONTAINER ?? "ailearn-dev-worker-1";
const OUT_PATH = process.env.BENCH_OUT ?? "";

/** 历史三条 block 笔记（与 dev 库 2026-08-24 成功 run 完全一致，便于纵向对照）。 */
const SMALL_NOTE = [
  { type: "heading", content: "<h1>牛顿第二定律</h1>" },
  { type: "paragraph", content: "牛顿第二定律说明物体的加速度与合外力成正比、与质量成反比，公式为 F=ma。" },
  { type: "paragraph", content: "例如相同质量下，施加两倍合外力会得到两倍加速度。" },
];

/** 多概念笔记：用于观察"调用数 N 增长时串行 vs 并发的差距"。 */
const MULTI_NOTE = [
  { type: "heading", content: "<h1>牛顿运动定律</h1>" },
  { type: "paragraph", content: "牛顿第一定律（惯性定律）：一切物体在没有受到外力作用时，总保持静止状态或匀速直线运动状态。" },
  { type: "paragraph", content: "牛顿第二定律：物体的加速度与合外力成正比、与质量成反比，公式为 F=ma。" },
  { type: "paragraph", content: "牛顿第三定律：两个物体之间的作用力与反作用力总是大小相等、方向相反、作用在同一条直线上。" },
  { type: "paragraph", content: "惯性的大小只由质量决定：质量越大，改变运动状态的难度越大，与速度无关。" },
  { type: "paragraph", content: "动量定理：合外力的冲量等于物体动量的变化量，即 FΔt = Δp。" },
];

const NOTE_BLOCKS = VARIANT === "small" ? SMALL_NOTE : MULTI_NOTE;

const TERMINAL = new Set([
  "review_ready", "no_cards_recommended", "needs_attention",
  "failed", "cancelled", "stale", "activated", "closed_without_activation",
]);

const admin = postgres(ADMIN_URL, { max: 4 });

/** 终态后等待日志落盘：最后一次 LLM 调用（pedagogy）的日志与 run 终态几乎同时发生，
 *  立即读 docker logs 会漏掉它（2026-09-17 实测：11/12 条）。 */
const LOG_SETTLE_MS = 2_500;

// ─── 逐调用耗时：解析 worker 容器日志 ────────────────────────────────────

function collectWorkerLog(sinceEpochMs: number): string {
  if (!CONTAINER) return "";
  try {
    return execFileSync(
      "docker",
      ["logs", CONTAINER, "--since", new Date(sinceEpochMs).toISOString()],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // docker logs 走 stderr 输出容器日志；execFileSync 有输出时也可能抛错，尽力解析。
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === "string" && stderr.length > 0) return stderr;
    return "";
  }
}

// ─── 播种 + 驱动一次真实生成 ─────────────────────────────────────────────

interface RoundResult {
  runId: string;
  wallMs: number;
  /**
   * run 创建 → outbox 行被 worker 认领（status='processing'）的延迟。
   *
   * 2026-09-17：这是纯固定开销，与 provider 无关。此前 V2 outbox **没有** NOTIFY
   * 触发器，worker 空转时轮询已退避到 5s（POLL_MAX_MS），于是每次生成都要白等
   * 最多 5s 才有人开始处理。迁移 0226 加了 AFTER INSERT 触发器（与主队列 jobs 同构）
   * 后应压到几百毫秒以内。50ms 轮询精度足够区分"立即唤醒"与"等下次轮询"。
   */
  claimLatencyMs: number | null;
  status: string;
  authored: number;
  grounded: number;
  calls: LlmCall[];
  sumLlmMs: number;
  maxLlmMs: number;
  stageCounts: Record<string, number>;
  /** 本轮日志窗口的结束时刻，作为下一轮的窗口起点（见主流程注释）。 */
  logWindowEndMs: number;
}

async function seedWorkspaceWithNote(): Promise<{ workspaceId: string; userId: string; versionId: string }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const versionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${`bench-${userId}@example.invalid`}, 'unused')`;
    // sendToExternal=true + 已签同意：真实 provider 调用的治理前置条件
    // （默认 ai_data_policy 是 sendToExternal=false，会直接拒绝外部调用）。
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by, ai_data_policy)
      VALUES (${workspaceId}, ${userId}, 'v2-llm-bench', 'v0.7-ai-use-2026-08-12', now(), ${userId},
              ${tx.json({ auditLogging: true, piiDetection: true, sendToExternal: true, sendImageContent: false })}::jsonb)`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by) VALUES (${noteId}, ${workspaceId}, 'v2-llm-bench', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteId}, ${workspaceId}, 1,
              ${tx.json({ blocks: NOTE_BLOCKS })}, ${`bench-${versionId}`}, ${userId})`;
    for (let i = 0; i < NOTE_BLOCKS.length; i += 1) {
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
        VALUES (${randomUUID()}, ${versionId}, ${workspaceId}, ${NOTE_BLOCKS[i].type}, ${NOTE_BLOCKS[i].content}, ${i + 1})`;
    }
  });
  return { workspaceId, userId, versionId };
}

async function runOnce(index: number, logSinceMs: number): Promise<RoundResult> {
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const { workspaceId, userId, versionId } = await seedWorkspaceWithNote();

  // 排队等待：确保同一时刻只有一个 run 在跑，日志窗口才能干净地归属到本次 run。
  // 只看**近期**run——dev 库里存在历史孤儿 run 永久停在 planning（其 outbox job
  // 早已终态、无 pending 可认领），把"近 30 分钟"之外的行算进忙碌会让本脚本永远等待。
  for (;;) {
    const busy = await admin`
      SELECT count(*)::int AS n FROM card_generation_runs_v2
      WHERE status IN ('queued','source_sealing','planning','authoring','checking')
        AND created_at > now() - interval '30 minutes'`;
    if ((busy[0]?.n ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const startedAt = Date.now();
  const { runId } = await createGenerationRunV2(
    { workspaceId, userId },
    versionId,
    {
      version: 2,
      noteVersionId: versionId,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive", hardMaxCards: 8 },
      preferredStrategies: ["recall", "why"],
      clientRequestId: `bench-${LABEL}-${index}-${randomUUID()}`,
    },
    `bench-key-${LABEL}-${index}-${randomUUID()}`,
  );

  let status = "unknown";
  let claimLatencyMs: number | null = null;
  /**
   * 等待 run **落定**：终态 + 该 run 没有 pending/processing 的 outbox job。
   *
   * 2026-09-17（修度量缺陷）：主管线可能把 run 短暂置为 needs_attention 并把新 revision
   * 交给 recheck job（唯一候选被判 rewrite 时必然如此）。只看"第一个终态"会把这种
   * **中间态**记成链路失败——实测 `micro-bound-authn-vs-authz` 被误记为失败，而它
   * 22 秒后就是 review_ready。落定判定避免这类误报。
   */
  for (;;) {
    const rows = await admin`
      SELECT r.status AS run_status,
             o.status AS outbox_status,
             (SELECT count(*)::int FROM card_generation_run_outbox_v2 p
              WHERE p.run_id = r.id AND p.status IN ('pending', 'processing')) AS pending_jobs
      FROM card_generation_runs_v2 r
      LEFT JOIN card_generation_run_outbox_v2 o ON o.run_id = r.id
      WHERE r.id = ${runId}
      ORDER BY o.created_at
      LIMIT 1`;
    status = String(rows[0]?.run_status ?? "unknown");
    if (claimLatencyMs === null && String(rows[0]?.outbox_status ?? "") === "processing") {
      claimLatencyMs = Date.now() - startedAt;
    }
    const pendingJobs = Number(rows[0]?.pending_jobs ?? 0);
    if (TERMINAL.has(status) && pendingJobs === 0) break;
    if (Date.now() - startedAt > 25 * 60_000) {
      status = `timeout(${status})`;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const wallMs = Date.now() - startedAt;

  const counts = await admin`
    SELECT
      count(*) FILTER (WHERE event_type = 'card_candidate.authored')::int AS authored,
      count(*) FILTER (WHERE event_type = 'card_candidate.grounding_passed')::int AS grounded
    FROM card_generation_events_v2 WHERE run_id = ${runId}`;

  const calls = parseChatJsonCalls(await (async () => {
    await new Promise((r) => setTimeout(r, LOG_SETTLE_MS));
    return collectWorkerLog(logSinceMs);
  })());
  const stageCounts: Record<string, number> = {};
  for (const call of calls) stageCounts[call.stage] = (stageCounts[call.stage] ?? 0) + 1;

  return {
    runId,
    wallMs,
    claimLatencyMs,
    status,
    authored: counts[0]?.authored ?? 0,
    grounded: counts[0]?.grounded ?? 0,
    calls,
    sumLlmMs: calls.reduce((sum, c) => sum + c.elapsedMs, 0),
    maxLlmMs: calls.reduce((max, c) => Math.max(max, c.elapsedMs), 0),
    stageCounts,
    logWindowEndMs: Date.now(),
  };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────

console.log(`[v2-llm-bench] label=${LABEL} rounds=${ROUNDS} note=${VARIANT} (${NOTE_BLOCKS.length} blocks) container=${CONTAINER || "(none)"}`);

const results: RoundResult[] = [];
// 日志窗口起点：每轮取"上一轮采集完成"的时刻，避免用"起点减若干秒"的余量把上一轮
// 最后一次调用（pedagogy）算进本轮（2026-09-17 实测：-3s 余量导致 sumLlm > wall，
// 即 overlap > 1 的假象）。轮与轮之间有 2.5s settle + 播种，且同一时刻只有一个 run。
let logWindowStart = Date.now();
for (let i = 0; i < ROUNDS; i += 1) {
  const result = await runOnce(i + 1, logWindowStart);
  logWindowStart = result.logWindowEndMs;
  results.push(result);
  const stages = Object.entries(result.stageCounts).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(
    `  round ${i + 1}/${ROUNDS}: status=${result.status} N=${result.authored} wall=${(result.wallMs / 1000).toFixed(1)}s `
    + `claim=${result.claimLatencyMs === null ? "n/a" : `${result.claimLatencyMs}ms`} `
    + `calls=${result.calls.length} sumLlm=${(result.sumLlmMs / 1000).toFixed(1)}s maxLlm=${(result.maxLlmMs / 1000).toFixed(1)}s `
    + `overlap=${result.wallMs > 0 ? (result.sumLlmMs / result.wallMs).toFixed(2) : "-"} [${stages}] run=${result.runId}`,
  );
}

const walls = results.map((r) => r.wallMs);
const elapsed = results.flatMap((r) => r.calls.map((c) => c.elapsedMs));
const perRound = results.map((r) => ({
  ...r,
  callCount: r.calls.length,
  stageCounts: r.stageCounts,
  calls: undefined,
}));

const summary = {
  label: LABEL,
  noteVariant: VARIANT,
  blockCount: NOTE_BLOCKS.length,
  rounds: ROUNDS,
  medianWallMs: median(walls),
  claimLatencyP50Ms: median(results.map((r) => r.claimLatencyMs ?? 0)),
  claimLatencyMaxMs: Math.max(0, ...results.map((r) => r.claimLatencyMs ?? 0)),
  medianCandidates: median(results.map((r) => r.authored)),
  medianLlmCalls: median(results.map((r) => r.calls.length)),
  medianSumLlmMs: median(results.map((r) => r.sumLlmMs)),
  medianOverlap: median(results.map((r) => (r.wallMs > 0 ? r.sumLlmMs / r.wallMs : 0))),
  llmCallP50Ms: percentile([...elapsed].sort((a, b) => a - b), 50),
  llmCallP90Ms: percentile([...elapsed].sort((a, b) => a - b), 90),
  llmCallMaxMs: elapsed.length ? Math.max(...elapsed) : 0,
  statuses: results.map((r) => r.status),
  runs: perRound,
};

console.log("\n=== 汇总（真实 LLM，端到端） ===");
console.log(`  标签：${LABEL} / 笔记：${VARIANT}（${NOTE_BLOCKS.length} blocks） / 轮数：${ROUNDS}`);
console.log(`  墙钟中位数：${(summary.medianWallMs / 1000).toFixed(1)}s`);
console.log(`  认领延迟（run 创建→worker 开始处理）：中位 ${summary.claimLatencyP50Ms}ms / 最大 ${summary.claimLatencyMaxMs}ms`);
console.log(`  候选数中位数：${summary.medianCandidates}`);
console.log(`  LLM 调用数中位数：${summary.medianLlmCalls}`);
console.log(`  LLM 耗时合计中位数：${(summary.medianSumLlmMs / 1000).toFixed(1)}s`);
console.log(`  单调用耗时 p50/p90/max：${(summary.llmCallP50Ms / 1000).toFixed(1)}s / ${(summary.llmCallP90Ms / 1000).toFixed(1)}s / ${(summary.llmCallMaxMs / 1000).toFixed(1)}s`);
console.log(`  重叠度 sumLlm/wall 中位数：${summary.medianOverlap.toFixed(2)}（1.00≈完全串行，越低越并发）`);
console.log(`  终态：${summary.statuses.join(", ")}`);
console.log(`  runIds：${results.map((r) => r.runId).join(", ")}`);

if (OUT_PATH) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  console.log(`\n已写入 ${OUT_PATH}`);
}

await admin.end();
const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
await closeDatabase().catch(() => undefined);
process.exit(0);
