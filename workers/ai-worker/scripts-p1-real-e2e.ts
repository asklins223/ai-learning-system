/**
 * P1-7 真实端到端验收脚本（P1 状态机自动推进）。
 *
 * 在本地 postgres + 真实 provider 上跑一个完整学习卡生成 run，
 * 验证 Phase 1 自动推进效果并采集统计：
 *   - P1-1: submit_deck_draft 成功后系统自动创建 Critic(无需模型调用 request_grounding_review)
 *   - P1-2: Critic passed 后系统自动创建 VERIFY
 *   - P1-5: 模型仍调用 request_grounding_review/request_verification 时返回
 *           deprecated_system_managed_transition(兼容期,不阻塞)
 *   - turn/provider 调用统计
 *
 * 用法(仓库根):
 *   DATABASE_URL="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn" \
 *     node --import tsx workers/ai-worker/scripts-p1-real-e2e.ts
 */

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "./src/lib/ai-provider.ts"; // 副作用:注册全部 provider 工厂
// 触发 worker 主循环(index.ts 顶层 main() 在 NODE_ENV != test 时 autostart)，
// worker 自己 claim/处理全部 job(含自动推进),脚本只 seed + 轮询 + 统计。
import "./src/index.ts";

// ─── 加载 .env ───────────────────────────────────────────────────────────
const envText = readFileSync(resolve(process.cwd(), ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const adminUrl = process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL_WORKER or DATABASE_URL is required");
const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000031";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000031";
// 样本参数化(P0-6 分层基线数据采集):SAMPLE_ID / SAMPLE_TITLE / SAMPLE_DENSITY / SAMPLE_CONTENT
const SAMPLE_ID = process.env.SAMPLE_ID ?? "031";
const NOTE_ID = `30000000-0000-4000-8000-000000000${SAMPLE_ID}`;
const VERSION_ID = `40000000-0000-4000-8000-000000000${SAMPLE_ID}`;
const RUN_ID = `50000000-0000-4000-8000-000000000${SAMPLE_ID}`;
const SAMPLE_DENSITY = process.env.SAMPLE_DENSITY ?? "standard";
const SAMPLE_TITLE = process.env.SAMPLE_TITLE ?? "CAP 定理与分布式共识";
const SAMPLE_CONTENT = process.env.SAMPLE_CONTENT ?? [
  "分布式系统的一致性、可用性和分区容错性无法同时满足，这是 CAP 定理的核心结论。",
  "两阶段提交协议通过准备阶段和提交阶段保证分布式事务的原子性，但存在协调者单点故障问题。",
  "Raft 算法通过领导者选举、日志复制和安全性保证达成共识，日志条目只能由领导者追加。",
  "Quorum 机制要求读写操作访问超过半数的节点，是许多分布式存储系统保证一致性的基础。",
  "幂等操作是指重复执行与执行一次结果相同的操作，分布式系统常用请求 ID 去重实现幂等。",
].join("\n");

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM jobs WHERE generation_run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${RUN_ID}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p1-real@example.invalid', 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'P1 real e2e', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'CAP 定理与分布式共识', ${USER_ID}, 1)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: SAMPLE_CONTENT }] })},
        'p1-real-source-hash', ${USER_ID}
      ) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (${VERSION_ID}, ${WORKSPACE_ID}, 0, 'paragraph', ${SAMPLE_CONTENT})
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units, budget_snapshot
      ) VALUES (
        ${RUN_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, ${VERSION_ID}, ${USER_ID},
        ${`p1-real-e2e-${SAMPLE_ID}`}, ${`p1-real-fp-${SAMPLE_ID}`}, 1,
        ${SAMPLE_TITLE}, 'p1-real-source-hash', 'block-hash', 'asset-hash',
        '[]'::jsonb, '[]'::jsonb, 'queued', 'queued', 1, 1, true, 1,
        ${tx.json({
          roles: {},
          maxProviderCalls: 60,
          maxInputTokens: 2_000_000,
          maxOutputTokens: 500_000,
          maxEmbeddingTokens: 200_000,
          maxParallelTasks: 6,
          runDeadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          costCap: 500,
        })}
      ) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_events
      (run_id, workspace_id, sequence, stage, state, completed, total, unit, message_code)
      VALUES (${RUN_ID}, ${WORKSPACE_ID}, 1, 'snapshot', 'queued', 1, 1, 'blocks', 'source_snapshot_sealed')
      ON CONFLICT DO NOTHING`;
    // prepare unit + job(仿 API service.ts 创建,worker 走真实 PREPARE 流程)
    const PREPARE_UNIT_ID = `60000000-0000-4000-8000-000000000${SAMPLE_ID}`;
    await tx`DELETE FROM card_generation_units WHERE id = ${PREPARE_UNIT_ID}`;
    await tx`INSERT INTO card_generation_units
      (id, workspace_id, run_id, kind, level, ordinal, unit_key, required,
       input_manifest, input_hash, status, cursor_json, budget_json, usage_json)
      VALUES (
        ${PREPARE_UNIT_ID}, ${WORKSPACE_ID}, ${RUN_ID}, 'prepare', 0, 0,
        ${`prepare:${RUN_ID}`}, true,
                ${tx.json({ density: SAMPLE_DENSITY })},
        ${`p1-real-fp-${SAMPLE_ID}`},
        'pending', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
      ) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO jobs
      (type, workspace_id, requested_by, payload, status, generation_run_id, generation_unit_id, stage,
       priority, resource_class, idempotency_key)
      VALUES (
        'execute_card_agent_turn', ${WORKSPACE_ID}, ${USER_ID},
        ${tx.json({ noteVersionId: VERSION_ID, generationRunId: RUN_ID, agentUnitId: PREPARE_UNIT_ID, turnNo: 0, inputHash: `p1-real-fp-${SAMPLE_ID}`, userId: USER_ID })},
        'pending', ${RUN_ID}, ${PREPARE_UNIT_ID}, 'snapshot', 80, 'card_foreground',
        ${`generation-run:${RUN_ID}:prepare:0`}
      ) ON CONFLICT DO NOTHING`;
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await seed();

  // worker 主循环在后台运行(index.ts autostart),脚本轮询 run 状态。
  const deadline = Date.now() + 12 * 60 * 1000; // 12 分钟超时
  let lastStatus = "";

  while (Date.now() < deadline) {
    const [run] = await admin<{ status: string; stage: string }[]>`
      SELECT status, stage FROM card_generation_runs WHERE id = ${RUN_ID}`;
    if (run && ["succeeded", "needs_attention", "cancelled", "superseded"].includes(run.status)) {
      break;
    }
    const cur = `${run?.status}:${run?.stage}`;
    if (cur !== lastStatus) {
      console.error(`[progress] ${cur} @ ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
      lastStatus = cur;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const elapsedMs = Date.now() - startedAt;

  // ─── 统计 ──────────────────────────────────────────────────────────────
  const [run] = await admin<{ status: string; stage: string }[]>`
    SELECT status, stage FROM card_generation_runs WHERE id = ${RUN_ID}`;

  const jobStats = await admin<{ status: string; count: number }[]>`
    SELECT status, count(*)::int AS count FROM jobs
    WHERE generation_run_id = ${RUN_ID} GROUP BY status ORDER BY status`;

  const roleStats = await admin<{ role: string; events: number }[]>`
    SELECT agent_role AS role, count(*)::int AS events
    FROM card_generation_agent_events
    WHERE run_id = ${RUN_ID}
    GROUP BY agent_role ORDER BY agent_role`;

  const toolStats = await admin<{ role: string; tool: string; events: number }[]>`
    SELECT agent_role AS role, tool_name AS tool, count(*)::int AS events
    FROM card_generation_agent_events
    WHERE run_id = ${RUN_ID} AND tool_name IS NOT NULL
    GROUP BY agent_role, tool_name ORDER BY agent_role, tool`;

  const unitStats = await admin<{ kind: string; status: string; count: number }[]>`
    SELECT kind, status, count(*)::int AS count
    FROM card_generation_units
    WHERE run_id = ${RUN_ID}
    GROUP BY kind, status ORDER BY kind, status`;

  const draftStats = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_drafts WHERE run_id = ${RUN_ID}`;

  const failedJobErrors = await admin<{ type: string; last_error: string | null }[]>`
    SELECT type, last_error FROM jobs
    WHERE generation_run_id = ${RUN_ID} AND status = 'dead'`;

  // 输出 JSON 摘要
  console.log(JSON.stringify({
    runStatus: run?.status,
    runStage: run?.stage,
    elapsedSec: Math.round(elapsedMs / 1000),
    jobs: jobStats,
    draftCount: draftStats[0]?.count ?? 0,
    units: unitStats,
    eventsByRole: roleStats,
    toolCalls: toolStats,
    deadJobErrors: failedJobErrors,
  }, null, 2));

  // ─── 验收断言 ──────────────────────────────────────────────────────────
  const succeeded = run?.status === "succeeded";
  if (!succeeded) {
    console.error(`\n✗ run 未成功: status=${run?.status} stage=${run?.stage}`);
    process.exitCode = 1;
    await admin.end({ timeout: 5 });
    // worker 主循环还挂着,显式退出
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
    return;
  }
  console.log(`\n✓ 真实 E2E run 成功(${(elapsedMs / 1000).toFixed(1)}s)`);
  await admin.end({ timeout: 5 });
  setTimeout(() => process.exit(0), 500);
}

main().catch(async (err) => {
  console.error("✗ 脚本失败:", err);
  process.exitCode = 1;
  await admin.end({ timeout: 5 });
});
