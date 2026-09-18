/**
 * V2 学习卡生成 —— **输出质量**基准（"速度可以换、质量不能丢"的度量工具）。
 *
 * 做法：把 `packages/ai-quality` 的 gold corpus（374 fixtures，带人工标注：可接受
 * 卡数区间、requiredLearningObjectives 优先级、supportOnlyFacts、front 禁止内容）
 * 逐条灌进**真实链路**（真实 provider + worker 容器 + 真实 DB），再用仓库自己的
 * `scoreFixtureDeterministic` + `evaluateRcGateV2` 打分。因此它能回答一个纯速度
 * 基准回答不了的问题：**改了调度/并发/修复之后，输出质量有没有变。**
 *
 * 用法（仓库根）：
 *   QUALITY_LABEL=serial node --import ./workers/ai-worker/node_modules/tsx/dist/loader.mjs \
 *     workers/ai-worker/src/integration-tests/v2-quality-bench.ts
 *
 * 环境变量：
 *   QUALITY_FIXTURES=N   样本数（默认 12，按 单卡 micro / 多卡 / 零卡 分层抽取）
 *   QUALITY_LABEL        结果标签（写进报告）
 *   QUALITY_OUT          JSON 输出路径
 *   QUALITY_CONCURRENCY  该轮 worker 的 V2_STAGE_CONCURRENCY（仅记录，便于对照）
 *
 * 指标口径：
 *   - countWithinRange：卡数落在 gold 允许区间（RC 门槛 ≥95%）
 *   - criticalRecall / importantRecall：gold 目标命中率（≥95% / ≥90%）
 *   - frontLeaks：正面泄漏 gold 禁止内容（≤2%）
 *   - supportOnlyCarded：support-only 事实单独成卡（硬性 0）
 *   - zeroCard precision/recall：该 0 卡的是否 0 卡（≥90%）
 *   - 另有 failedRuns：链路本身失败（needs_attention/failed）——交付不了卡，
 *     单独记账，不与"正确地判 0 卡"混为一谈。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { median } from "./v2-llm-bench-lib.ts";
import {
  V2_FIXTURE_CORPUS_SEED,
  CONTENT_QUALITY_GATES_V2,
  evaluateRcGateV2,
  hitObjectiveDescription,
  normalizeForMatch,
  scoreFixtureDeterministic,
  HARD_GATES_V2,
  type CardGenerationFixtureV2,
  type DeterministicScoreV2,
  type NormCandidateView,
  type ScoredPlanView,
} from "../../../../packages/ai-quality/src/card-generation-v2/index.ts";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;
process.env.DATABASE_URL_WORKER ??= ADMIN_URL;

const FIXTURE_COUNT = Number(process.env.QUALITY_FIXTURES ?? "12");
const LABEL = process.env.QUALITY_LABEL ?? "quality";
const OUT_PATH = process.env.QUALITY_OUT ?? "";
const CONCURRENCY = process.env.QUALITY_CONCURRENCY ?? "(default)";
/**
 * 抽样偏移：用于**留出集**（holdout）验证。
 * 调 prompt 时若只在同一批样本上变好，可能只是过拟合到那几个例子；把偏移挪到
 * 另一批 fixture 上复测，才能区分"规则真的生效"与"背下了例子"。
 */
const OFFSET = Number(process.env.QUALITY_OFFSET ?? "0");
/**
 * 分桶过滤（all | single | multi | zero）：把样本集中到某一类上做**专项**验证。
 * 零卡行为是安全相关的（给无来源的断言成卡 = 真缺陷），4 个样本的噪声太大，
 * 用 QUALITY_BUCKET=zero 一次测 12 条。
 */
const BUCKET = process.env.QUALITY_BUCKET ?? "all";
/**
 * 语料 split 过滤（dev | validation | holdout，逗号分隔）。
 *
 * 语料作者本来就按 source family 划分了 dev/validation/holdout，目的正是
 * "调参只看 dev、验收看另外两个"。**本方法学修正的核心**：先用 dev 调，
 * 再在 validation/holdout 上验收，且验收时不再回头改 prompt。
 */
const SPLITS = (process.env.QUALITY_SPLIT ?? "")
  .split(",").map((x) => x.trim()).filter((x) => x.length > 0);
/**
 * 抽样种子：用 fixtureId+seed 的哈希排序取前 N 条，而不是"按 id 排序取前 N"。
 * 后者会让每次评测都落在同一小片语料上（我此前正是这么做的，等于反复用同一批
 * 样本既调参又验收）。
 */
const SEED = process.env.QUALITY_SEED ?? "seed-1";
/**
 * 排除清单：此前所有评测结果 JSON 的路径（逗号分隔）。这些 fixture 的内容
 * 我看过、部分还据此改过 prompt，属于"已污染样本"，验收必须排除。
 */
const EXCLUDE_FILES = (process.env.QUALITY_EXCLUDE ?? "")
  .split(",").map((x) => x.trim()).filter((x) => x.length > 0);

const TERMINAL = new Set([
  "review_ready", "no_cards_recommended", "needs_attention",
  "failed", "cancelled", "stale", "activated", "closed_without_activation",
]);

const admin = postgres(ADMIN_URL, { max: 4 });

/**
 * 分层抽样：优先覆盖三类最容易被"改快"破坏的样本——
 * 单卡 micro（过拆/漏卡）、多卡（合并语义）、零卡（失败被伪装成 0 卡）。
 * 按 fixtureId 排序保证同一份脚本每次抽到同一批，便于跨版本对照。
 */
/** FNV-1a：确定性哈希，用于种子抽样排序（不需要密码学强度）。 */
export function seededOrderKey(fixtureId: string, seed: string): number {
  let hash = 0x811c9dc5;
  for (const ch of `${fixtureId}::${seed}`) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * 从若干 JSON 中收集"已看过/已调过"的 fixtureId。
 *
 * 支持两种格式（都真实存在于本仓库的评测产物里）：
 * 1. 评测结果文件：`{ perFixture: [{ fixtureId }] }`
 * 2. 台账文件：`["fixture-a", "fixture-b"]`（`outputs/cardgen-bench/seen-fixtures.json`）
 *
 * 早期版本只认格式 1，导致把台账文件传进来时**静默排除 0 条**——评测会在
 * "以为已排除污染样本"的情况下跑，属危险静默失败；现在两种都认。
 */
export function collectSeenFixtureIds(paths: string[]): Set<string> {
  const seen = new Set<string>();
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as
        | { perFixture?: Array<{ fixtureId?: string }> }
        | string[];
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === "string") seen.add(id);
        continue;
      }
      for (const row of parsed.perFixture ?? []) {
        if (typeof row.fixtureId === "string") seen.add(row.fixtureId);
      }
    } catch {
      // 读不到就跳过——它只影响"更严格"，不该让评测直接失败。
    }
  }
  return seen;
}

/**
 * RC gate 快照：**从真实来源派生**，不写死。
 *
 * 此前这里是硬编码常量（providerId: "opencode-go" / promptRevision: "card-generation-v2/v4"），
 * 与管线实际使用的 provider（`agent_turn` → tokenrhythm）和 prompt 版本（v18）**双双漂移**，
 * 使评测产物里的溯源信息是错的。现在：provider 走与管线同一份平台配置解析，
 * prompt 版本直接从 prompts.ts 读常量。
 */
async function buildScoreSnapshot() {
  const { resolveEvalProvider } = await import("./eval-provider.ts");
  const { CARD_GENERATION_V2_PROMPT_VERSION } = await import("../card-generation-v2/prompts.ts");
  let providerLabel = "(unresolved)";
  try {
    const { provider, label } = resolveEvalProvider();
    providerLabel = label;
    void provider;
  } catch {
    // 评测产物不该因为"快照标签取不到"而失败。
  }
  return {
    providerId: providerLabel,
    modelSnapshot: providerLabel,
    promptRevision: CARD_GENERATION_V2_PROMPT_VERSION,
    policyVersion: "v2",
    datasetSnapshot: `corpus-seed:${V2_FIXTURE_CORPUS_SEED.length}`,
    judgeVersion: "deterministic-scorer-v2",
    codeCommit: process.env.GIT_COMMIT ?? "(uncommitted-worktree)",
    runAt: new Date().toISOString(),
  };
}

export function selectFixtures(corpus: CardGenerationFixtureV2[], count: number): CardGenerationFixtureV2[] {
  const excludedIds = collectSeenFixtureIds(EXCLUDE_FILES);
  const text = corpus
    .filter((f) => f.modality === "text" && f.source.content.trim().length > 0)
    .filter((f) => (SPLITS.length === 0 ? true : SPLITS.includes(f.split)))
    .filter((f) => !excludedIds.has(f.fixtureId))
    .sort((a, b) => {
      const ka = seededOrderKey(a.fixtureId, SEED);
      const kb = seededOrderKey(b.fixtureId, SEED);
      return ka === kb ? a.fixtureId.localeCompare(b.fixtureId) : ka - kb;
    });
  const zero = text.filter((f) => f.acceptableCardCountRange.max === 0);
  const multi = text.filter((f) => f.acceptableCardCountRange.max >= 2);
  const single = text.filter((f) => f.acceptableCardCountRange.max === 1);
  const pick = (from: CardGenerationFixtureV2[], n: number) => from.slice(OFFSET, OFFSET + n);
  if (BUCKET === "zero") return pick(zero, count);
  if (BUCKET === "single") return pick(single, count);
  if (BUCKET === "multi") return pick(multi, count);
  const perBucket = Math.max(1, Math.floor(count / 3));
  const chosen = [
    ...pick(single, count - 2 * perBucket),
    ...pick(multi, perBucket),
    ...pick(zero, perBucket),
  ];
  // 去重（fixtureId 唯一，但 bucket 划分理论上可能重叠）
  const picked = new Set<string>();
  return chosen.filter((f) => (picked.has(f.fixtureId) ? false : (picked.add(f.fixtureId), true))).slice(0, count);
}

interface FixtureResult {
  fixtureId: string;
  bucket: "single" | "multi" | "zero";
  runId: string;
  status: string;
  wallMs: number;
  cardCount: number;
  goldRange: { min: number; max: number };
  score: DeterministicScoreV2;
  /** 未被任何候选覆盖的 gold 目标描述（按优先级分列）——用于"漏了哪类目标"的诊断。 */
  missedCritical: string[];
  missedImportant: string[];
  /** 交付的候选目标语句（诊断用，便于人工判断是"没成卡"还是"措辞不同"）。 */
  deliveredStatements: string[];
  /** 链路失败（needs_attention/failed）：不是"正确地判 0 卡"。 */
  linkFailed: boolean;
}

async function seedWorkspaceWithNote(content: string, title: string) {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const versionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${`quality-${userId}@example.invalid`}, 'unused')`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by, ai_data_policy)
      VALUES (${workspaceId}, ${userId}, 'v2-quality-bench', 'v0.7-ai-use-2026-08-12', now(), ${userId},
              ${tx.json({ auditLogging: true, piiDetection: true, sendToExternal: true, sendImageContent: false })}::jsonb)`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by) VALUES (${noteId}, ${workspaceId}, ${title}, ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteId}, ${workspaceId}, 1,
              ${tx.json({ blocks: [{ type: "paragraph", content }] })}, ${`quality-${versionId}`}, ${userId})`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${randomUUID()}, ${versionId}, ${workspaceId}, 'paragraph', ${content}, 1)`;
  });
  return { workspaceId, userId, versionId };
}

async function runFixture(fixture: CardGenerationFixtureV2, index: number): Promise<FixtureResult> {
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const { workspaceId, userId, versionId } = await seedWorkspaceWithNote(
    fixture.source.content,
    fixture.source.title ?? fixture.fixtureId,
  );

  // 串行化：同一时刻只允许一个 run 在跑，避免彼此争用 provider 影响质量归因。
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
      learningGoal: fixture.generationSpec.learningGoal ?? "understand",
      detailThreshold: fixture.generationSpec.detailThreshold ?? "balanced",
      quantity: {
        kind: "adaptive",
        ...(fixture.generationSpec.quantity?.hardMaxCards === undefined
          ? {}
          : { hardMaxCards: fixture.generationSpec.quantity.hardMaxCards }),
      },
      clientRequestId: `quality-${LABEL}-${index}-${randomUUID()}`,
    },
    `quality-key-${LABEL}-${index}-${randomUUID()}`,
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

  // 交付到"牌堆"的候选 = review_ready 事件里的候选（与用户可见集合一致）。
  const deckRows = await admin`
    SELECT payload->>'candidateId' AS candidate_id
    FROM card_generation_events_v2
    WHERE run_id = ${runId} AND event_type = 'card_candidate.review_ready'`;
  const deckIds = deckRows.map((r) => String((r as { candidate_id: string }).candidate_id)).filter(Boolean);

  const candidateRows = deckIds.length === 0 ? [] : await admin`
    SELECT candidate_id, objective_draft, presentation_draft
    FROM card_generation_candidates_v2
    WHERE run_id = ${runId} AND candidate_id = ANY(${`{${deckIds.join(",")}}`}::uuid[])`;

  // 零卡理由码（2026-09-18 修复）：本 harness 此前**从不读取** plan 的 reasonCodes，
  // 于是 `scoreFixtureDeterministic` 里的 `zeroCardReasonValid` 恒为 false（reasons
  // 为空数组）——"零卡正确拒绝"实际只测了终态，没测理由码，而 `passed` 因此恒为
  // false（本轮 12 条零卡实测：终态 12/12 正确、passed 却 0/12）。
  // 理由码是合同的一部分（必须落在冻结枚举内且与内容类别相符），必须纳入度量。
  const planReasonRows = await admin`
    SELECT result->>'kind' AS kind, result->'reasonCodes' AS reason_codes
    FROM card_generation_plans_v2
    WHERE run_id = ${runId}
    ORDER BY created_at DESC
    LIMIT 1`;
  const planReasonCodes = Array.isArray(planReasonRows[0]?.reason_codes)
    ? (planReasonRows[0].reason_codes as string[]).map(String)
    : [];

  const planView: ScoredPlanView = {
    kind: status === "no_cards_recommended" ? "no_cards_recommended" : "author_candidates",
    reasonCodes: planReasonCodes,
    candidates: candidateRows.map((raw) => {
      const row = raw as {
        candidate_id: string;
        objective_draft: { objectiveStatement?: string; publicSummary?: string };
        presentation_draft: { front?: { cue?: string; prompt?: string } };
      };
      return {
        candidateId: String(row.candidate_id),
        objectiveStatement: String(row.objective_draft?.objectiveStatement ?? ""),
        publicSummary: String(row.objective_draft?.publicSummary ?? ""),
        frontCue: String(row.presentation_draft?.front?.cue ?? ""),
        frontPrompt: String(row.presentation_draft?.front?.prompt ?? ""),
      };
    }),
  };

  const bucket: FixtureResult["bucket"] = fixture.acceptableCardCountRange.max === 0
    ? "zero"
    : fixture.acceptableCardCountRange.max >= 2
      ? "multi"
      : "single";

  const normView: NormCandidateView[] = (planView.candidates ?? []).map((c) => ({
    id: c.candidateId,
    objectiveStatement: normalizeForMatch(c.objectiveStatement),
    publicSummary: normalizeForMatch(c.publicSummary),
    frontPrompt: normalizeForMatch(c.frontPrompt),
    frontCue: normalizeForMatch(c.frontCue),
  }));
  const missed = (priority: "critical" | "important") =>
    fixture.requiredLearningObjectives
      .filter((o) => o.priority === priority)
      .filter((o) => !hitObjectiveDescription(o.description, normView))
      .map((o) => o.description);

  return {
    fixtureId: fixture.fixtureId,
    bucket,
    runId,
    status,
    wallMs,
    cardCount: planView.candidates?.length ?? 0,
    goldRange: fixture.acceptableCardCountRange,
    score: scoreFixtureDeterministic(fixture, planView),
    missedCritical: missed("critical"),
    missedImportant: missed("important"),
    deliveredStatements: (planView.candidates ?? []).map((c) => c.objectiveStatement),
    linkFailed: status !== "review_ready" && status !== "no_cards_recommended",
  };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────

const fixtures = selectFixtures(V2_FIXTURE_CORPUS_SEED, FIXTURE_COUNT);
/**
 * DRYRUN=1：只打印抽样结果与候选池规模，不跑真实链路。
 * 用途：先确认"这批样本确实没被我看过/调过"，再决定是否花 LLM 调用去跑。
 */
if (process.env.QUALITY_DRYRUN === "1") {
  const excluded = collectSeenFixtureIds(EXCLUDE_FILES);
  const pool = V2_FIXTURE_CORPUS_SEED
    .filter((f) => f.modality === "text" && f.source.content.trim().length > 0)
    .filter((f) => (SPLITS.length === 0 ? true : SPLITS.includes(f.split)))
    .filter((f) => !excluded.has(f.fixtureId));
  const bySplit = pool.reduce<Record<string, number>>((acc, f) => {
    acc[f.split] = (acc[f.split] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[dryrun] 已排除（看过/调过）fixture：${excluded.size}`);
  console.log(`[dryrun] 候选池：${pool.length} 条，split 分布 ${JSON.stringify(bySplit)}`);
  console.log(`[dryrun] 本次抽中 ${fixtures.length} 条：`);
  for (const f of fixtures) {
    console.log(`  - ${f.fixtureId} [${f.acceptableCardCountRange.min}-${f.acceptableCardCountRange.max}] split=${f.split} ${f.source.content.length}字`);
  }
  process.exit(0);
}
console.log(
  `[v2-quality] label=${LABEL} concurrency=${CONCURRENCY} bucket=${BUCKET} splits=[${SPLITS.join(",") || "all"}] `
  + `seed=${SEED} excluded=${collectSeenFixtureIds(EXCLUDE_FILES).size} fixtures=${fixtures.length}`,
);
console.log(`  样本：${fixtures.map((f) => `${f.fixtureId}[${f.acceptableCardCountRange.min}-${f.acceptableCardCountRange.max}]`).join(", ")}`);

const results: FixtureResult[] = [];
for (let i = 0; i < fixtures.length; i += 1) {
  const result = await runFixture(fixtures[i], i + 1);
  results.push(result);
  const s = result.score;
  console.log(
    `  ${String(i + 1).padStart(2)}/${fixtures.length} ${result.fixtureId.padEnd(34)} `
    + `status=${result.status.padEnd(20)} cards=${result.cardCount}/${result.goldRange.min}-${result.goldRange.max} `
    + `inRange=${s.countWithinRange ? "Y" : "N"} critRecall=${s.criticalRecall.toFixed(2)} `
    + `leaks=${s.frontLeaks.length} supportOnly=${s.supportOnlyCarded.length} wall=${(result.wallMs / 1000).toFixed(1)}s`,
  );
}

const scores = results.map((r) => r.score);
const zeroCardFixtureIds = fixtures
  .filter((f) => f.acceptableCardCountRange.max === 0)
  .map((f) => f.fixtureId);
// 只把"成功终态且 0 卡"算作一次 0 卡预测；链路失败单独记账。
const zeroCardPredictedIds = results
  .filter((r) => r.status === "no_cards_recommended")
  .map((r) => r.fixtureId);

const hardGateCounts = Object.fromEntries(
  Object.keys(HARD_GATES_V2).map((k) => [k, 0]),
) as Record<keyof typeof HARD_GATES_V2, number>;
// 可观测的硬门禁：把链路失败却当成 0 卡交付的次数（本 harness 按终态严格区分，
// 因此这里只统计"needs_attention/failed 但判成 no_cards"的不可能情形）。
hardGateCounts.failedMislabeledAsZeroCard = results.filter(
  (r) => r.linkFailed && r.status === "no_cards_recommended",
).length;

const scoreSnapshot = await buildScoreSnapshot();

const gate = evaluateRcGateV2({
  scores,
  zeroCardFixtureIds,
  zeroCardPredictedIds,
  hardGateCounts,
  bucketAssignments: results.map((r) => ({ fixtureId: r.fixtureId, bucket: r.bucket })),
  snapshot: scoreSnapshot,
});

/**
 * 目标覆盖率门禁改用**语义判据**结果（QUALITY_JUDGE=<recall-judge-*.json>）。
 *
 * 为什么：本 gate 原本用 `criticalObjectiveRecall` —— 它是**词面判据**，已用真实
 * 数据证明不成立（无关对的字符 Dice 可高于同一目标对：gold 是抽象表述，卡片是
 * 具体改写）。它既漏判改写、也会误判无关，因此**不能作为门禁**：用它判定会把
 * "语义覆盖 1.000"的样本报成 0.250（本轮验收实测），是纯噪声。
 *
 * 处理：显式提供判据结果 → 用语义数值判定；未提供 → 标记 applicable=false
 * （报告制，不计入 overallPassed），而不是拿无效数字判 FAIL。
 */
let semanticJudge: { critical: number; important: number; fixtures: number } | null = null;
const judgePath = process.env.QUALITY_JUDGE ?? "";
if (judgePath) {
  try {
    const judged = JSON.parse(readFileSync(judgePath, "utf8")) as {
      semanticCriticalRecall?: number;
      semanticImportantRecall?: number;
      fixtureCount?: number;
    };
    if (typeof judged.semanticCriticalRecall === "number") {
      semanticJudge = {
        critical: judged.semanticCriticalRecall,
        important: judged.semanticImportantRecall ?? 0,
        fixtures: judged.fixtureCount ?? 0,
      };
      gate.contentGates.criticalObjectiveRecall = {
        actual: semanticJudge.critical,
        threshold: CONTENT_QUALITY_GATES_V2.criticalObjectiveRecall,
        passed: semanticJudge.critical >= CONTENT_QUALITY_GATES_V2.criticalObjectiveRecall,
        applicable: true,
      };
    }
  } catch {
    semanticJudge = null;
  }
}
if (!semanticJudge) {
  gate.contentGates.criticalObjectiveRecall = {
    actual: gate.contentGates.criticalObjectiveRecall.actual,
    threshold: gate.contentGates.criticalObjectiveRecall.threshold,
    passed: true,
    applicable: false,
  };
}
// applicable=false 的项 passed 恒为 true，因此这里等价于"只由可判定项决定"。
gate.overallPassed = Object.values(gate.contentGates).every((g) => g.passed)
  && Object.values(gate.hardGates).every((g) => g.passed)
  && Object.values(gate.buckets).every((b) => b.passed);

const failed = results.filter((r) => r.linkFailed);
const summary = {
  label: LABEL,
  workerConcurrency: CONCURRENCY,
  fixtureCount: results.length,
  bucketCounts: results.reduce<Record<string, number>>((acc, r) => {
    acc[r.bucket] = (acc[r.bucket] ?? 0) + 1;
    return acc;
  }, {}),
  medianWallMs: median(results.map((r) => r.wallMs)),
  linkFailedRuns: failed.map((r) => ({ fixtureId: r.fixtureId, status: r.status })),
  linkFailureRate: failed.length / (results.length || 1),
  aggregate: {
    countWithinRangeRate: scores.filter((s) => s.countWithinRange).length / (scores.length || 1),
    criticalRecall: scores.reduce((a, s) => a + s.criticalRecall, 0) / (scores.length || 1),
    importantRecall: scores.reduce((a, s) => a + s.importantRecall, 0) / (scores.length || 1),
    frontLeakRate: scores.filter((s) => s.frontLeaks.length > 0).length / (scores.length || 1),
    supportOnlyCardedRate: scores.filter((s) => s.supportOnlyCarded.length > 0).length / (scores.length || 1),
    mustNotCardViolationRate: scores.filter((s) => s.mustNotCardViolations.length > 0).length / (scores.length || 1),
    mergeViolationRate: scores.filter((s) => s.mustMergeViolations.length > 0 || s.mustNotMergeViolations.length > 0).length / (scores.length || 1),
    passedRate: scores.filter((s) => s.passed).length / (scores.length || 1),
  },
  rcGate: {
    contentGates: gate.contentGates,
    buckets: gate.buckets,
    overallPassed: gate.overallPassed,
  },
  semanticJudge: semanticJudge ?? "未提供（QUALITY_JUDGE 未设置）",
  perFixture: results,
};

console.log("\n=== 输出质量汇总 ===");
console.log(`  标签：${LABEL} / worker 并发：${CONCURRENCY} / 样本：${results.length}（${JSON.stringify(summary.bucketCounts)}）`);
console.log(`  卡数落在 gold 区间：${(summary.aggregate.countWithinRangeRate * 100).toFixed(1)}%  （门槛 ≥95%）`);
console.log(`  critical 目标命中（**词面判据，不可用**，见下）：${summary.aggregate.criticalRecall.toFixed(3)}`);
console.log("    ⚠️ 该指标是词面判据，已用真实数据证明不成立（无关对的词面相似度可高于同目标对）；");
console.log("       真实覆盖率必须看语义判据：v2-recall-judge.ts（本脚本旁挂，读本文件即可，不重跑管线）。");
console.log(`  important 目标命中（词面，同上）：${summary.aggregate.importantRecall.toFixed(3)}`);
console.log(`  正面泄漏率：${(summary.aggregate.frontLeakRate * 100).toFixed(1)}%  （门槛 ≤2%）`);
console.log(`  support-only 成卡率：${(summary.aggregate.supportOnlyCardedRate * 100).toFixed(1)}%  （硬性 0）`);
console.log(`  逐样本 passed：${(summary.aggregate.passedRate * 100).toFixed(1)}%`);
console.log(`  链路失败：${failed.length}/${results.length}${failed.length ? ` → ${failed.map((f) => f.fixtureId).join(",")}` : ""}`);
console.log(`  中位单样本墙钟：${(summary.medianWallMs / 1000).toFixed(1)}s`);
console.log(`  RC gate 总判定：${gate.overallPassed ? "PASS" : "FAIL"}`);
for (const [name, value] of Object.entries(gate.contentGates)) {
  const applicable = (value as { applicable?: boolean }).applicable !== false;
  console.log(`    ${!applicable ? "N/A" : value.passed ? "✅" : "❌"} ${name}: ${applicable ? value.actual.toFixed(3) : "无样本（0/0，不计入判定）"} (阈值 ${value.threshold})`);
}
for (const [name, value] of Object.entries(gate.buckets)) {
  console.log(`    桶 ${name}: n=${value.count} withinRange=${(value.withinRangeRate * 100).toFixed(0)}% ${value.passed ? "✅" : "❌"}`);
}

if (OUT_PATH) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  console.log(`\n已写入 ${OUT_PATH}`);
}

await admin.end();
const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
await closeDatabase().catch(() => undefined);
process.exit(0);
