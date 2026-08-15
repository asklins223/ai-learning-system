/**
 * QLT-01: E2E 测试 fixture seed CLI（ADR-0008 §2）
 *
 * 直接在 PostgreSQL 中创建版本化、非生产用的测试数据。
 * 根据测试 profile 的不同，创建不同规模的数据：
 *   - pr      ：2 工作区 + owner/member + 12 笔记/卡片/复习计划（PR smoke + CI 重试余量）
 *   - nightly ：2 工作区 + owner/member + 51 笔记/卡片/复习计划（分页边界）
 *   - rc      ：2 工作区 + owner/member + 100 笔记/卡片 + 1000 搜索文档（大数据边界）
 *
 * 不提供公共 HTTP seed 后端 —— 所有数据通过直接数据库访问创建。
 *
 * 用法：
 *   npx tsx seed/seed.ts --profile pr --run-id <uuid> --output <path>
 *   npx tsx seed/seed.ts --profile nightly --run-id <uuid> --output <path>
 *   npx tsx seed/seed.ts --profile rc --run-id <uuid> --output <path>
 *   npx tsx seed/seed.ts --cleanup <run-id>
 *
 * 环境变量：
 *   SEED_DATABASE_URL — PostgreSQL 连接字符串（默认与开发环境相同）
 *   E2E_SEED_DATABASE_CONFIRM — 非默认目标及所有 cleanup 的显式确认值
 *                               （错误消息会给出目标绑定值）
 *
 * 输出格式（匹配 fixtures.ts 的 SeedCredentials）：
 *   {
 *     "runId": "<uuid>",
 *     "profile": "pr|nightly|rc",
 *     "workspaces": [{
 *       "name": "Seed Workspace <runId>",
 *       "slug": "seed-<runId>",
 *       "ownerEmail": "seed-owner-<runId>@e2e.test",
 *       "ownerPassword": "<明文>",
 *       "memberEmail": "seed-member-<runId>@e2e.test",
 *       "memberPassword": "<明文>",
 *       "noteIds": ["<uuid>"],
 *       "cardIds": ["<uuid>"]
 *     }]
 *   }
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import postgres from "postgres";
import bcrypt from "bcryptjs";

// ─── CLI 参数解析 ────────────────────────────────────────────────────────

/**
 * Seed CLI 参数结构。
 */
interface SeedArgs {
  /** 测试 profile：pr（PR smoke）、nightly（ nightly 回归）、rc（RC 全量） */
  profile: "pr" | "nightly" | "rc";
  /** 运行 ID，用于隔离不同次 seed 的数据 */
  runId: string;
  /** 输出文件路径 */
  output: string;
  /** 清理模式：传入 runId 时清理对应数据 */
  cleanup: string | null;
}

/**
 * 解析命令行参数。
 *
 * 支持 --profile、--run-id、--output、--cleanup 四个参数。
 * 未提供时使用默认值。
 */
function parseArgs(): SeedArgs {
  const args = process.argv.slice(2);
  const result: SeedArgs = {
    profile: "pr",
    runId: randomUUID(),
    output: "/tmp/seed-output.json",
    cleanup: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--profile") {
      if (!next || next.startsWith("--")) throw new Error("--profile requires a value");
      if (next !== "pr" && next !== "nightly" && next !== "rc") {
        throw new Error(`Invalid --profile ${JSON.stringify(next)}; expected pr, nightly, or rc.`);
      }
      result.profile = next;
      i++;
    } else if (arg === "--run-id") {
      if (!next || next.startsWith("--")) throw new Error("--run-id requires a value");
      result.runId = next;
      i++;
    } else if (arg === "--output") {
      if (!next || next.startsWith("--")) throw new Error("--output requires a value");
      result.output = next;
      i++;
    } else if (arg === "--cleanup") {
      if (!next || next.startsWith("--")) throw new Error("--cleanup requires a run-id");
      result.cleanup = next;
      i++;
    } else {
      throw new Error(`Unknown seed argument: ${arg}`);
    }
  }

  return result;
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** bcrypt 哈希成本因子 */
const BCRYPT_COST = 10;
/** owner 用户明文密码（输出到 fixture 文件供 E2E 登录使用） */
const OWNER_PASSWORD = "OwnerPass123!";
/** member 用户明文密码 */
const MEMBER_PASSWORD = "MemberPass123!";
const DEFAULT_SEED_DATABASE_URL =
  "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
/** fixture 契约要求 runId 使用规范 UUID，避免空值/通配符污染清理范围 */
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * 各 profile 对应的数据规模配置。
 *
 * - pr      ：12 条笔记/卡片/复习计划 —— 覆盖多个消费队列的旅程并为 CI 重试留出余量
 * - nightly ：51 条 —— 分页边界测试（默认分页 50 条 + 1 条溢出）
 * - rc      ：100 条笔记/卡片 + 1000 条搜索文档 —— 大数据量边界
 */
const PROFILE_CONFIG: Record<
  SeedArgs["profile"],
  { noteCount: number; searchDocCount: number; description: string }
> = {
  pr: { noteCount: 12, searchDocCount: 0, description: "PR smoke（12 条卡片）" },
  nightly: { noteCount: 51, searchDocCount: 0, description: "Nightly 回归（51 条分页边界）" },
  rc: { noteCount: 100, searchDocCount: 1000, description: "RC 全量（100 条卡片 + 1000 条搜索文档）" },
};

// ─── Seed 输出结构 ──────────────────────────────────────────────────────────

/**
 * Seed 输出结构，匹配 fixtures.ts 的 SeedCredentials。
 */
interface SeedOutput {
  runId: string;
  profile: SeedArgs["profile"];
  workspaces: Array<{
    name: string;
    slug: string;
    ownerEmail: string;
    ownerPassword: string;
    memberEmail: string;
    memberPassword: string;
    workspaceId: string;
    noteIds: string[];
    cardIds: string[];
  }>;
}

// ─── Safety helpers ────────────────────────────────────────────────────────

/**
 * Seed/cleanup 永远不能在 production 进程中运行。
 *
 * 这项检查必须发生在建立数据库连接之前；即使 production 恰好配置了一个
 * 可连接的 SEED_DATABASE_URL，也不能通过该 CLI 写入或删除数据。
 */
function assertNonProductionEnvironment(): void {
  if (process.env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error("E2E seed and cleanup are disabled when NODE_ENV=production.");
  }
}

/**
 * Seed 默认只允许仓库内置的本地开发目标。任何其他目标必须同时满足：
 * 1. 数据库名明确标记为 test/e2e/ci/dev；2. host/database 不含生产标识；
 * 3. 操作者提供与目标绑定的显式确认值。这样即使 NODE_ENV 被遗漏，也
 * 不会因复制了生产 DATABASE_URL 而直接写入或清理真实数据。
 */
function assertSafeDatabaseTarget(
  databaseUrl: string,
  requireConfirmation = false,
): void {
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error("SEED_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("SEED_DATABASE_URL must use postgres:// or postgresql://.");
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const targetLabel = `${target.hostname}:${target.port || "5432"}/${databaseName}`;
  const expectedConfirmation = `CONFIRM_E2E_SEED:${targetLabel}`;
  if (databaseUrl === DEFAULT_SEED_DATABASE_URL) {
    if (
      requireConfirmation
      && process.env.E2E_SEED_DATABASE_CONFIRM !== expectedConfirmation
    ) {
      throw new Error(
        `E2E cleanup requires E2E_SEED_DATABASE_CONFIRM=${expectedConfirmation}`,
      );
    }
    return;
  }

  if (/prod(?:uction)?|primary|master/i.test(`${target.hostname}/${databaseName}`)) {
    throw new Error(`Refusing production-like E2E seed target: ${targetLabel}.`);
  }
  if (!/(?:^|[_-])(?:test|e2e|ci|dev)(?:$|[_-])/i.test(databaseName)) {
    throw new Error(
      `Refusing E2E seed target without a test-marked database name: ${targetLabel}.`,
    );
  }

  if (process.env.E2E_SEED_DATABASE_CONFIRM !== expectedConfirmation) {
    throw new Error(
      `Non-default E2E seed target requires E2E_SEED_DATABASE_CONFIRM=${expectedConfirmation}`,
    );
  }
}

/** 验证并规范化 fixture 命名空间。 */
function normalizeRunId(runId: string): string {
  const normalized = runId.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Invalid run-id ${JSON.stringify(runId)}: expected a canonical UUID.`);
  }
  return normalized;
}

/**
 * 使用完整 UUID（去掉连字符）生成数据库中可检索的唯一命名空间。
 * 不能只取前八位，否则不同 runId 可能共享账号或被 cleanup 一并删除。
 */
function namespaceForRun(runId: string): string {
  return runId.replaceAll("-", "");
}

// ─── Seed 函数 ──────────────────────────────────────────────────────────────

/**
 * 执行 seed 操作，创建 E2E 测试所需的 fixture 数据。
 *
 * 所有数据在一个事务中创建，确保原子性。
 * runId 用于隔离不同次 seed 的数据，支持并行运行。
 * profile 决定创建的数据规模（pr/nightly/rc）。
 *
 * @param args - CLI 参数
 * @returns seed 输出（包含登录凭据）
 */
async function seed(args: SeedArgs): Promise<SeedOutput> {
  const runId = normalizeRunId(args.runId);
  const databaseUrl =
    process.env.SEED_DATABASE_URL ??
    DEFAULT_SEED_DATABASE_URL;
  assertSafeDatabaseTarget(databaseUrl);

  // 限制连接数，避免占用过多数据库连接
  const sql = postgres(databaseUrl, { max: 2 });

  try {
    const namespace = namespaceForRun(runId);
    const workspaceName = `Seed Workspace ${namespace}`;
    const isolatedWorkspaceName = `Seed Workspace B ${namespace}`;
    const slug = `seed-${namespace}`;
    const isolatedSlug = `seed-b-${namespace}`;
    const ownerEmail = `seed-owner-${namespace}@e2e.test`;
    const isolatedOwnerEmail = `seed-owner-b-${namespace}@e2e.test`;
    const memberEmail = `seed-member-${namespace}@e2e.test`;

    const config = PROFILE_CONFIG[args.profile];

    console.log(`[seed] Profile: ${args.profile} (${config.description})`);
    console.log(`[seed] Run ID: ${runId}`);
    console.log(`[seed] Workspace slug: ${slug}`);
    console.log(`[seed] Data scale: ${config.noteCount} notes/cards, ${config.searchDocCount} search docs`);

    // 预计算密码哈希，避免在事务中阻塞
    const ownerPasswordHash = await bcrypt.hash(OWNER_PASSWORD, BCRYPT_COST);
    const isolatedOwnerPasswordHash = await bcrypt.hash(OWNER_PASSWORD, BCRYPT_COST);
    const memberPasswordHash = await bcrypt.hash(MEMBER_PASSWORD, BCRYPT_COST);

    const result = await sql.begin(async (tx) => {
      // 同一 runId 的并发 seed 必须串行化。事务锁释放后，后到的调用会在
      // 下方存在性检查中显式失败，避免插入一半后才碰到唯一约束。
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`e2e-seed:${runId}`}, 0)
        )
      `;

      const existingUsers = await tx`
        SELECT email
        FROM users
        WHERE email IN (${ownerEmail}, ${isolatedOwnerEmail}, ${memberEmail})
        LIMIT 1
      `;
      const existingWorkspaces = await tx`
        SELECT id
        FROM workspaces
        WHERE name IN (${workspaceName}, ${isolatedWorkspaceName})
        LIMIT 1
      `;
      if (existingUsers.length > 0 || existingWorkspaces.length > 0) {
        throw new Error(
          `Seed data already exists for run-id ${runId}; run cleanup before retrying.`,
        );
      }

      // 1. 创建用户（先 owner 再 member，因为 workspace.owner_id 引用 users.id）
      const [owner] = await tx`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (
          ${randomUUID()},
          ${ownerEmail},
          ${ownerPasswordHash},
          'owner'
        )
        RETURNING id
      `;

      const [member] = await tx`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (
          ${randomUUID()},
          ${memberEmail},
          ${memberPasswordHash},
          'owner'
        )
        RETURNING id
      `;

      const [isolatedOwner] = await tx`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (
          ${randomUUID()},
          ${isolatedOwnerEmail},
          ${isolatedOwnerPasswordHash},
          'owner'
        )
        RETURNING id
      `;

      // 2. 创建工作区
      // 方案 16/20 e2e：seed 工作区需具备已签署的 AI 使用协议（ai_consent_*）
      // 且 ai_data_policy.send_to_external = true，否则前端 consent gate
      // （ai-consent-gate.tsx）与 worker governance（checkAIConsent）会
      // 拒绝所有 AI 生成任务，PR 旅程无法走通。
      const [workspace] = await tx`
        INSERT INTO workspaces (id, name, owner_id, ai_consent_version, ai_consent_at, ai_consent_by, ai_data_policy)
        VALUES (
          ${randomUUID()},
          ${workspaceName},
          ${owner.id},
          'e2e-seed-consent-v1',
          NOW(),
          ${owner.id},
          '{"sendToExternal": true, "sendImageContent": false, "piiDetection": true, "auditLogging": true}'::jsonb
        )
        RETURNING id
      `;

      const [isolatedWorkspace] = await tx`
        INSERT INTO workspaces (id, name, owner_id, ai_consent_version, ai_consent_at, ai_consent_by, ai_data_policy)
        VALUES (
          ${randomUUID()},
          ${isolatedWorkspaceName},
          ${isolatedOwner.id},
          'e2e-seed-consent-v1',
          NOW(),
          ${isolatedOwner.id},
          '{"sendToExternal": true, "sendImageContent": false, "piiDetection": true, "auditLogging": true}'::jsonb
        )
        RETURNING id
      `;

      // 3. 创建工作区成员关系
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${workspace.id}, ${owner.id}, 'owner')
      `;
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${workspace.id}, ${member.id}, 'member')
      `;
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${isolatedWorkspace.id}, ${isolatedOwner.id}, 'owner')
      `;
      // The shared member belongs to both workspaces so workspace switching
      // can be exercised without granting the primary owner cross-tenant access.
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${isolatedWorkspace.id}, ${member.id}, 'member')
      `;

      // 4. 创建来源（笔记依赖来源）
      const [source] = await tx`
        INSERT INTO sources (id, workspace_id, type, title, status, created_by)
        VALUES (
          ${randomUUID()},
          ${workspace.id},
          'text',
          ${`Seed Source ${runId.slice(0, 8)}`},
          'ready',
          ${owner.id}
        )
        RETURNING id
      `;

      // 5. 创建笔记/卡片/复习计划（数量由 profile 决定）。
      // 每张卡需要独立的 note_version_id，因为唯一索引
      // learning_cards_workspace_note_version_active_unique_idx
      // 要求每个 (workspace_id, note_version_id) 只能有一张 active 卡。
      const cardIds: string[] = [];
      const keyPointIds: string[] = [];
      const noteIds: string[] = [];
      for (let i = 0; i < config.noteCount; i++) {
        const quoteText = `Supporting quote for card ${i + 1}`;
        const blockContent = `Seed content ${i + 1} for testing. ${quoteText}`;
        const contentJson = JSON.stringify({
          blocks: [{ type: "paragraph", text: blockContent }],
        });
        const [note] = await tx`
          INSERT INTO notes (id, workspace_id, title, source_id, created_by)
          VALUES (
            ${randomUUID()},
            ${workspace.id},
            ${`Seed Note ${i + 1}`},
            ${source.id},
            ${owner.id}
          )
          RETURNING id
        `;
        noteIds.push(note.id);

        const [noteVersion] = await tx`
          INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
          VALUES (
            ${randomUUID()},
            ${note.id},
            ${workspace.id},
            1,
            ${contentJson}::jsonb,
            md5(${contentJson}::text),
            ${owner.id}
          )
          RETURNING id
        `;

        // 更新笔记的 current_version_id 指向刚创建的版本
        await tx`
          UPDATE notes SET current_version_id = ${noteVersion.id}
          WHERE id = ${note.id}
        `;

        // The Companion PREPARE path consumes the same canonical card graph as
        // production: active card set → active card → generation run epoch →
        // evidence. Keep the seed fixture on that path instead of creating a
        // legacy standalone card that can render but cannot start a Session.
        const generationRunId = randomUUID();
        const cardSetId = randomUUID();
        await tx`
          INSERT INTO card_generation_runs (
            id,
            workspace_id,
            note_id,
            note_version_id,
            requested_by,
            request_idempotency_key,
            generation_fingerprint,
            generation_epoch,
            title_snapshot,
            source_content_hash,
            block_manifest_hash,
            asset_manifest_hash,
            status,
            stage,
            started_at,
            updated_at
          )
          VALUES (
            ${generationRunId},
            ${workspace.id},
            ${note.id},
            ${noteVersion.id},
            ${owner.id},
            ${`e2e-${runId}-${i}`},
            ${`e2e-fingerprint-${runId}-${i}`},
            1,
            ${`Seed Note ${i + 1}`},
            md5(${contentJson}::text),
            md5(${blockContent}),
            md5(''),
            'queued',
            'queued',
            NOW(),
            NOW()
          )
        `;
        await tx`
          INSERT INTO learning_card_sets (
            id,
            workspace_id,
            note_id,
            note_version_id,
            generation_run_id,
            status,
            title,
            summary,
            activated_at
          )
          VALUES (
            ${cardSetId},
            ${workspace.id},
            ${note.id},
            ${noteVersion.id},
            ${generationRunId},
            'active',
            ${`Seed Card Set ${i + 1}`},
            ${`Seed card set for Companion E2E ${i + 1}.`},
            NOW()
          )
        `;

        const [noteBlock] = await tx`
          INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
          VALUES (
            ${randomUUID()},
            ${noteVersion.id},
            ${workspace.id},
            0,
            'paragraph',
            ${blockContent}
          )
          RETURNING id
        `;

        // 创建学习卡
        const [card] = await tx`
          INSERT INTO learning_cards (
            id, note_version_id, workspace_id, card_set_id, generation_run_id,
            scope, scope_key, ordinal, status, schema_json
          )
          VALUES (
            ${randomUUID()},
            ${noteVersion.id},
            ${workspace.id},
            ${cardSetId},
            ${generationRunId},
            'section',
            ${`section-${i}`},
            1,
            'active',
            ${JSON.stringify({
              title: `Seed Card ${i + 1}`,
              summary: `Test card ${i + 1} for E2E review attempt journey.`,
            })}::jsonb
          )
          RETURNING id
        `;
        cardIds.push(card.id);

        await tx`
          UPDATE card_generation_runs
          SET status = 'succeeded',
              stage = 'complete',
              result_card_set_id = ${cardSetId},
              result_card_id = ${card.id},
              finished_at = NOW(),
              updated_at = NOW()
          WHERE id = ${generationRunId}
        `;

        // 为每张卡创建一个 key point
        const [keyPoint] = await tx`
          INSERT INTO card_key_points (card_id, workspace_id, ordinal, claim, quote_text)
          VALUES (
            ${card.id},
            ${workspace.id},
            0,
            ${`Key point for seed card ${i + 1}`},
            ${quoteText}
          )
          RETURNING id
        `;
        keyPointIds.push(keyPoint.id);

        await tx`
          INSERT INTO evidences (
            id,
            workspace_id,
            key_point_id,
            block_id,
            block_ordinal,
            quote_text,
            alignment,
            alignment_score,
            alignment_method
          )
          VALUES (
            ${randomUUID()},
            ${workspace.id},
            ${keyPoint.id},
            ${noteBlock.id},
            0,
            ${quoteText},
            'aligned',
            100,
            'exact'
          )
        `;
      }

      // A minimal isolated tenant fixture provides a real foreign note ID for
      // browser-level cross-workspace authorization assertions.
      const isolatedQuote = "Isolated workspace supporting quote";
      const isolatedContent = `Private tenant B content. ${isolatedQuote}`;
      const isolatedContentJson = JSON.stringify({
        blocks: [{ type: "paragraph", text: isolatedContent }],
      });
      const [isolatedSource] = await tx`
        INSERT INTO sources (id, workspace_id, type, title, status, created_by)
        VALUES (
          ${randomUUID()},
          ${isolatedWorkspace.id},
          'text',
          'Tenant B Source',
          'ready',
          ${isolatedOwner.id}
        )
        RETURNING id
      `;
      const [isolatedNote] = await tx`
        INSERT INTO notes (id, workspace_id, title, source_id, created_by)
        VALUES (
          ${randomUUID()},
          ${isolatedWorkspace.id},
          'Tenant B Private Note',
          ${isolatedSource.id},
          ${isolatedOwner.id}
        )
        RETURNING id
      `;
      const [isolatedVersion] = await tx`
        INSERT INTO note_versions (
          id, note_id, workspace_id, version_no, content_json, content_hash, created_by
        )
        VALUES (
          ${randomUUID()},
          ${isolatedNote.id},
          ${isolatedWorkspace.id},
          1,
          ${isolatedContentJson}::jsonb,
          md5(${isolatedContentJson}::text),
          ${isolatedOwner.id}
        )
        RETURNING id
      `;
      await tx`
        UPDATE notes SET current_version_id = ${isolatedVersion.id}
        WHERE id = ${isolatedNote.id}
      `;

      // 6. 创建到期复习计划（owner），用于 review attempt E2E 旅程
      // 每张卡都有独立的到期复习计划。PR profile 的 12 条队列同时
      // 支持多个会消费 schedule 的旅程，并为 CI retry 留出余量。
      const scheduleCount = cardIds.length;
      for (let i = 0; i < scheduleCount; i++) {
        await tx`
          INSERT INTO review_schedules (
            id, workspace_id, user_id, subject_type, subject_id, key_point_id,
            status, next_review_at, interval_days, generation
          )
          VALUES (
            ${randomUUID()},
            ${workspace.id},
            ${owner.id},
            'card',
            ${cardIds[i]},
            ${keyPointIds[i]},
            'pending',
            NOW(),
            1,
            1
          )
        `;
      }

      // 7. 创建 onboarding 状态：owner 已完成，member 待完成
      // 7a. Journey V2 邀请(offered):sandbox/own-content 旅程的起始状态
      // (P6 的 Pet 欢迎→offered 转换尚未接线;seed 提供 offered 初始契约)。
      await tx`
        INSERT INTO companion_account_invitations (user_id, status, offered_at, revision)
        VALUES (${owner.id}, 'offered', NOW(), 1)
      `;
      await tx`
        INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
        VALUES (
          ${workspace.id},
          ${owner.id},
          'v1',
          ${JSON.stringify({
            ai_consent: true,
            first_content: true,
            first_note: true,
            first_card: true,
            evidence_review: true,
            first_validation: true,
          })}::jsonb,
          'completed'
        )
      `;
      await tx`
        INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
        VALUES (
          ${isolatedWorkspace.id},
          ${isolatedOwner.id},
          'v1',
          ${JSON.stringify({
            ai_consent: true,
            first_content: true,
            first_note: true,
          })}::jsonb,
          'completed'
        )
      `;
      await tx`
        INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
        VALUES (
          ${isolatedWorkspace.id},
          ${member.id},
          'v1',
          ${JSON.stringify({})}::jsonb,
          'pending'
        )
      `;
      await tx`
        INSERT INTO onboarding_states (workspace_id, user_id, version, steps, status)
        VALUES (
          ${workspace.id},
          ${member.id},
          'v1',
          ${JSON.stringify({})}::jsonb,
          'pending'
        )
      `;

      // 8. RC profile：创建大量搜索文档以测试搜索/列表性能边界
      if (config.searchDocCount > 0) {
        // 批量插入搜索文档，每批 100 条以避免单次 INSERT 过大
        const batchSize = 100;
        for (let batch = 0; batch < config.searchDocCount; batch += batchSize) {
          const batchEnd = Math.min(batch + batchSize, config.searchDocCount);
          const documents: Array<{
            id: string;
            workspace_id: string;
            object_type: string;
            object_id: string;
            title: string;
            body: string;
            metadata: string;
            indexed_at: Date;
          }> = [];
          for (let i = batch; i < batchEnd; i++) {
            documents.push({
              id: randomUUID(),
              workspace_id: workspace.id,
              object_type: "source",
              object_id: randomUUID(),
              title: `Search Document ${i + 1}`,
              body: `Searchable content for document ${i + 1} — boundary testing.`,
              metadata: JSON.stringify({ type: "text", batchIndex: i }),
              indexed_at: new Date(),
            });
          }
          await tx`
            INSERT INTO search_documents ${tx(
              documents,
              "id",
              "workspace_id",
              "object_type",
              "object_id",
              "title",
              "body",
              "metadata",
              "indexed_at",
            )}
          `;
        }
      }

      return {
        workspace,
        isolatedWorkspace,
        isolatedNote,
        owner,
        isolatedOwner,
        member,
        cardIds,
        noteIds,
      };
    });

    console.log(`[seed] Created workspace: ${result.workspace.id}`);
    console.log(`[seed] Owner: ${result.owner.id} (${ownerEmail})`);
    console.log(`[seed] Member: ${result.member.id} (${memberEmail})`);
    console.log(`[seed] Isolated workspace: ${result.isolatedWorkspace.id}`);
    console.log(`[seed] Isolated owner: ${result.isolatedOwner.id} (${isolatedOwnerEmail})`);
    console.log(`[seed] ${config.noteCount} learning cards created`);
    console.log(`[seed] ${config.noteCount} review schedules created`);
    if (config.searchDocCount > 0) {
      console.log(`[seed] ${config.searchDocCount} search documents created`);
    }

    return {
      runId,
      profile: args.profile,
      workspaces: [
        {
          name: workspaceName,
          slug,
          ownerEmail,
          ownerPassword: OWNER_PASSWORD,
          memberEmail,
          memberPassword: MEMBER_PASSWORD,
          workspaceId: result.workspace.id,
          noteIds: result.noteIds,
          cardIds: result.cardIds,
        },
        {
          name: isolatedWorkspaceName,
          slug: isolatedSlug,
          ownerEmail: isolatedOwnerEmail,
          ownerPassword: OWNER_PASSWORD,
          memberEmail,
          memberPassword: MEMBER_PASSWORD,
          workspaceId: result.isolatedWorkspace.id,
          noteIds: [result.isolatedNote.id],
          cardIds: [],
        },
      ],
    };
  } finally {
    await sql.end();
  }
}

// ─── 清理函数 ───────────────────────────────────────────────────────────────

/**
 * 清理指定 runId 的 seed 数据。
 *
 * 按 FK 依赖顺序删除：先删除依赖表，再删除 users 和 workspaces。
 * 支持幂等清理——不存在的数据不会报错。
 *
 * @param runId - 要清理的运行 ID
 */
async function cleanup(runId: string): Promise<void> {
  const normalizedRunId = normalizeRunId(runId);
  const namespace = namespaceForRun(normalizedRunId);
  const ownerEmail = `seed-owner-${namespace}@e2e.test`;
  const isolatedOwnerEmail = `seed-owner-b-${namespace}@e2e.test`;
  const memberEmail = `seed-member-${namespace}@e2e.test`;
  // Invitation journeys create real accounts so registration itself is
  // exercised. Match only the fully anchored, reserved e2e.test namespace
  // produced by invite-onboarding.spec.ts; never use an open-ended LIKE.
  const inviteeEmailPattern =
    `^e2e-(join|remove)-(chromium-1440-pr|chromium-1440|chromium-390|chromium-768|firefox-1440)-`
    + `${namespace}-[0-9]+@e2e\\.test$`;
  const workspaceName = `Seed Workspace ${namespace}`;
  const isolatedWorkspaceName = `Seed Workspace B ${namespace}`;
  const databaseUrl =
    process.env.SEED_DATABASE_URL ??
    DEFAULT_SEED_DATABASE_URL;
  assertSafeDatabaseTarget(databaseUrl, true);

  const sql = postgres(databaseUrl, { max: 2 });

  try {
    const result = await sql.begin(async (tx) => {
      // 与 seed 使用同一把事务锁，避免 cleanup 和同 runId seed 交错执行。
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`e2e-seed:${normalizedRunId}`}, 0)
        )
      `;

      // Seed identities are exact matches. Registration identities use a
      // fully anchored allowlist regex containing the complete UUID namespace,
      // known project names and the reserved e2e.test domain.
      const users = await tx`
        SELECT id, email FROM users
        WHERE email IN (${ownerEmail}, ${isolatedOwnerEmail}, ${memberEmail})
           OR email ~ ${inviteeEmailPattern}
      `;
      const userIds = users.map((user) => user.id);
      const workspaces = userIds.length > 0
        ? await tx`
            SELECT id FROM workspaces
            WHERE name IN (${workspaceName}, ${isolatedWorkspaceName})
               OR owner_id = ANY(${userIds})
          `
        : await tx`
            SELECT id FROM workspaces
            WHERE name IN (${workspaceName}, ${isolatedWorkspaceName})
          `;

      // 先清理工作区相关数据（cascade 会处理大部分，但显式删除更安全）
      if (workspaces.length > 0) {
        const wsIds = workspaces.map((w) => w.id);
        // personal_workspace_id points back to workspaces without ON DELETE
        // SET NULL. Break that cycle before removing seed-owned workspaces;
        // the matching users are removed later in the same transaction.
        await tx`
          UPDATE users
          SET personal_workspace_id = NULL
          WHERE personal_workspace_id = ANY(${wsIds})
        `;
        // 删除顺序：先删成员关系，再删工作区（cascade 处理其余）
        await tx`DELETE FROM workspace_members WHERE workspace_id = ANY(${wsIds})`;
        await tx`DELETE FROM workspaces WHERE id = ANY(${wsIds})`;
      }

      // 再清理用户相关数据
      if (users.length > 0) {
        // 按 FK 依赖顺序删除引用 users 的表
        // note_versions.created_by、sources.created_by、notes.created_by
        await tx`DELETE FROM workspace_members WHERE user_id = ANY(${userIds})`;
        await tx`DELETE FROM review_schedules WHERE user_id = ANY(${userIds})`;
        await tx`DELETE FROM onboarding_states WHERE user_id = ANY(${userIds})`;
        await tx`DELETE FROM note_versions WHERE created_by = ANY(${userIds})`;
        await tx`DELETE FROM sources WHERE created_by = ANY(${userIds})`;
        await tx`DELETE FROM notes WHERE created_by = ANY(${userIds})`;
        // 最后删除用户本身
        await tx`DELETE FROM users WHERE id = ANY(${userIds})`;
      }

      return { removedUsers: users.length, removedWorkspaces: workspaces.length };
    });

    console.log(`[seed] Cleaned up run-id: ${runId}`);
    console.log(
      `[seed] Removed ${result.removedUsers} users, ${result.removedWorkspaces} workspaces`,
    );
  } finally {
    await sql.end();
  }
}

// ─── 主入口 ────────────────────────────────────────────────────────────────

/**
 * CLI 主入口。
 *
 * 如果传入 --cleanup 参数，执行清理操作；
 * 否则执行 seed 操作并输出 fixture 文件。
 */
async function main() {
  assertNonProductionEnvironment();
  const args = parseArgs();

  if (args.cleanup) {
    await cleanup(args.cleanup);
    return;
  }

  const output = await seed(args);

  // 写入输出文件，供 E2E 测试读取登录凭据
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify(output, null, 2));
  console.log(`[seed] Output written to: ${args.output}`);
}

main().catch((err) => {
  console.error("[seed] Fatal error:", err);
  process.exit(1);
});
