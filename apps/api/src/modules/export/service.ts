import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ValidationFeedback } from "@ailearn/shared";
import { db } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, sources, sourceSegments } from "../../db/schema/note.ts";
import { computeContentHash } from "../note/service.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import {
  evidences,
  validationEvents,
  reviewSchedules,
  reviewAttempts,
  understandingEvents,
  evidenceOverrides,
  validationQuestions,
} from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { jobs } from "../../db/schema/job.ts";
import { workspaces, workspaceMembers, users, onboardingStates } from "../../db/schema/identity.ts";
// v0.6: 可信掌握闭环新表 (计划 §6.9: 导出/导入覆盖)
import {
  validationQuestionRubricItems,
  validationSubmissions,
  validationSubmissionJobs,
  validationActionCommands,
  validationAssistanceExposures,
  validationPointAssessments,
  schedulingShadowDecisions,
  validationQualitySignals,
} from "../../db/schema/validation-v2.ts";
import {
  generateDefaultWorkspaceName,
  RECOVERED_PASSWORD_SENTINEL,
} from "../identity/service.ts";
import { logger } from "../../lib/logger.ts";

type RestoreDatabase = Pick<typeof db, "query" | "transaction">;

/**
 * 导出整个 workspace 的数据为 JSON。
 *
 * F-033: 使用事务（REPEATABLE READ 隔离级别）保证一致性快照。
 * N-009: 导出包含 users 和 workspace_members，使数据可恢复到空库。
 *
 * 所有查询在同一事务内执行，避免并发写入导致跨时点数据不一致。
 * 导出操作不获取写锁，不影响正常业务读写。
 */
export async function exportWorkspace(workspaceId: string) {
  // F-033: 使用事务保证一致性快照
  return db.transaction(async (tx) => {
    // workspace 信息
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });

    // N-009: 导出 workspace members（包含 userId 和 role，用于恢复时重建成员关系）
    const memberRows = await tx.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.workspaceId, workspaceId),
    });

    // N-009: 导出相关 users（不导出 passwordHash，恢复时需要重新设置密码）
    const userIds = [workspace?.ownerId, ...memberRows.map((m) => m.userId)].filter(Boolean) as string[];
    const userRows = userIds.length
      ? await tx.query.users.findMany({
          where: inArray(users.id, userIds),
        })
      : [];

    // CONC-03: 只导出未软删除的笔记
    const noteRows = await tx.query.notes.findMany({
      where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      orderBy: (n, { desc }) => [desc(n.updatedAt)],
    });

    // note versions
    const noteVersionRows = noteRows.length
      ? await tx.query.noteVersions.findMany({
          where: eq(noteVersions.workspaceId, workspaceId),
          orderBy: (v, { asc: a }) => [a(v.noteId), a(v.versionNo)],
        })
      : [];

    // note blocks
    const versionIds = noteVersionRows.map((v) => v.id);
    const noteBlockRows = versionIds.length
      ? await tx.query.noteBlocks.findMany({
          where: eq(noteBlocks.workspaceId, workspaceId),
          orderBy: (b, { asc: a }) => [a(b.versionId), a(b.ordinal)],
        })
      : [];

    // sources
    const sourceRows = await tx.query.sources.findMany({
      where: eq(sources.workspaceId, workspaceId),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });

    // source segments
    const sourceSegmentRows = await tx.query.sourceSegments.findMany({
      where: eq(sourceSegments.workspaceId, workspaceId),
      orderBy: (s, { asc: a }) => [a(s.sourceId), s.ordinal],
    });

    // learning cards
    const cardRows = await tx.query.learningCards.findMany({
      where: eq(learningCards.workspaceId, workspaceId),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });

    // card key points
    const cardKeyPointRows = await tx.query.cardKeyPoints.findMany({
      where: eq(cardKeyPoints.workspaceId, workspaceId),
      orderBy: (k, { asc: a }) => [a(k.cardId), a(k.ordinal)],
    });

    // evidences
    const evidenceRows = await tx.query.evidences.findMany({
      where: eq(evidences.workspaceId, workspaceId),
    });

    // N-005: evidence overrides
    const evidenceOverrideRows = await tx.query.evidenceOverrides.findMany({
      where: eq(evidenceOverrides.workspaceId, workspaceId),
    });

    // N-003: validation questions
    const validationQuestionRows = await tx.query.validationQuestions.findMany({
      where: eq(validationQuestions.workspaceId, workspaceId),
    });

    // validation events
    const validationEventRows = await tx.query.validationEvents.findMany({
      where: eq(validationEvents.workspaceId, workspaceId),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });

    // review schedules
    const reviewScheduleRows = await tx.query.reviewSchedules.findMany({
      where: eq(reviewSchedules.workspaceId, workspaceId),
      orderBy: (r, { desc }) => [desc(r.createdAt)],
    });

    // review attempts (LOOP-01/02) — must follow review_schedules in export
    // ordering so restore can insert parent before child.
    const reviewAttemptRows = await tx.query.reviewAttempts.findMany({
      where: eq(reviewAttempts.workspaceId, workspaceId),
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });

    // understanding events
    const understandingEventRows = await tx.query.understandingEvents.findMany({
      where: eq(understandingEvents.workspaceId, workspaceId),
      orderBy: (u, { desc }) => [desc(u.createdAt)],
    });

    // ai artifacts
    const aiArtifactRows = await tx.query.aiArtifacts.findMany({
      where: eq(aiArtifacts.workspaceId, workspaceId),
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });

    // v0.6: 可信掌握闭环新表导出 (计划 §6.9)
    // validation_question_rubric_items
    const rubricItemRows = await tx.query.validationQuestionRubricItems.findMany({
      where: eq(validationQuestionRubricItems.workspaceId, workspaceId),
      orderBy: (r, { asc: a }) => [a(r.questionId), a(r.ordinal)],
    });

    // validation_submissions — user-private, RLS-enforced
    const submissionRows = await tx.query.validationSubmissions.findMany({
      where: eq(validationSubmissions.workspaceId, workspaceId),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });

    // validation_submission_jobs
    const submissionJobRows = await tx.query.validationSubmissionJobs.findMany({
      where: inArray(validationSubmissionJobs.submissionId, submissionRows.map((s) => s.id)),
      orderBy: (j, { asc: a }) => [a(j.submissionId), a(j.phase), a(j.phaseOrdinal)],
    });

    // validation_action_commands — user-private, RLS-enforced
    const actionCommandRows = await tx.query.validationActionCommands.findMany({
      where: eq(validationActionCommands.workspaceId, workspaceId),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });

    // validation_assistance_exposures — user-private, RLS-enforced
    const assistanceExposureRows = await tx.query.validationAssistanceExposures.findMany({
      where: eq(validationAssistanceExposures.workspaceId, workspaceId),
      orderBy: (e, { desc }) => [desc(e.lastExposedAt)],
    });

    // validation_point_assessments — user-private, RLS-enforced
    const pointAssessmentRows = await tx.query.validationPointAssessments.findMany({
      where: eq(validationPointAssessments.workspaceId, workspaceId),
      orderBy: (p, { asc: a }) => [a(p.submissionId)],
    });

    // scheduling_shadow_decisions — user-private, RLS-enforced
    const shadowDecisionRows = await tx.query.schedulingShadowDecisions.findMany({
      where: eq(schedulingShadowDecisions.workspaceId, workspaceId),
      orderBy: (s, { desc }) => [desc(s.createdAt)],
    });

    // validation_quality_signals — user-private, RLS-enforced
    const qualitySignalRows = await tx.query.validationQualitySignals.findMany({
      where: eq(validationQualitySignals.workspaceId, workspaceId),
      orderBy: (q, { desc }) => [desc(q.createdAt)],
    });

    // onboarding states (SEC-02/ALPHA-01) — per-user onboarding progress.
    // invite_codes are NOT exported: they contain token hashes which are
    // security-sensitive credentials, not business data.
    const onboardingStateRows = await tx.query.onboardingStates.findMany({
      where: eq(onboardingStates.workspaceId, workspaceId),
      orderBy: (o, { desc }) => [desc(o.updatedAt)],
    });

    return {
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            ownerId: workspace.ownerId,
            workspaceType: workspace.workspaceType,
            // N-011: 导出 AI 隐私治理配置
            aiProvider: workspace.aiProvider,
            aiConsentVersion: workspace.aiConsentVersion,
            aiConsentAt: workspace.aiConsentAt,
            aiConsentBy: workspace.aiConsentBy,
            aiDataPolicy: workspace.aiDataPolicy,
          }
        : null,
      // N-009: 导出 identity 数据，使数据可恢复
      // 注意：不导出 passwordHash，恢复时需要重新设置密码
      users: userRows.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        personalWorkspaceId: u.personalWorkspaceId,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      })),
      workspaceMembers: memberRows,
      notes: noteRows,
      noteVersions: noteVersionRows,
      noteBlocks: noteBlockRows,
      sources: sourceRows,
      sourceSegments: sourceSegmentRows,
      learningCards: cardRows,
      cardKeyPoints: cardKeyPointRows,
      evidences: evidenceRows,
      evidenceOverrides: evidenceOverrideRows,
      validationQuestions: validationQuestionRows,
      validationEvents: validationEventRows,
      reviewSchedules: reviewScheduleRows,
      reviewAttempts: reviewAttemptRows,
      understandingEvents: understandingEventRows,
      aiArtifacts: aiArtifactRows,
      onboardingStates: onboardingStateRows,
      // v0.6: 可信掌握闭环新表 (计划 §6.9)
      validationQuestionRubricItems: rubricItemRows,
      validationSubmissions: submissionRows,
      validationSubmissionJobs: submissionJobRows,
      validationActionCommands: actionCommandRows,
      validationAssistanceExposures: assistanceExposureRows,
      validationPointAssessments: pointAssessmentRows,
      schedulingShadowDecisions: shadowDecisionRows,
      validationQualitySignals: qualitySignalRows,
      /**
       * 导出清单：明确哪些数据已包含、哪些未包含。
       * N-009: 新增 users 和 workspaceMembers，导出文件现在可用于恢复。
       * v0.6: 新增可信掌握闭环 8 张表，覆盖 §6.9 导出/导入要求。
       */
      exportManifest: {
        included: [
          "workspace",
          "users",
          "workspaceMembers",
          "notes",
          "noteVersions",
          "noteBlocks",
          "sources",
          "sourceSegments",
          "learningCards",
          "cardKeyPoints",
          "evidences",
          "evidenceOverrides",
          "validationQuestions",
          "validationEvents",
          "reviewSchedules",
          "reviewAttempts",
          "understandingEvents",
          "aiArtifacts",
          "onboardingStates",
          // v0.6: 可信掌握闭环新表
          "validationQuestionRubricItems",
          "validationSubmissions",
          "validationSubmissionJobs",
          "validationActionCommands",
          "validationAssistanceExposures",
          "validationPointAssessments",
          "schedulingShadowDecisions",
          "validationQualitySignals",
        ],
        excluded: {
          searchDocuments: "可重建 — 调用 POST /search/reindex 即可从主表重建",
          benchmarkReports: "运行态 — 基准测试报告，不随 workspace 导出",
          benchmarkLabels: "运行态 — 人工标注数据，不随 workspace 导出",
          jobs: "运行态 — AI 任务队列，不随 workspace 导出",
          sessions: "安全敏感 — 用户会话令牌，不应导出",
          passwordHashes: "安全敏感 — 用户密码哈希不导出，恢复后需重置密码",
          aiAuditLog: "运行态 — AI 审计日志，不随 workspace 导出",
          inviteCodes: "安全敏感 — 邀请 token hash 属凭据数据，不随导出",
        },
        version: "2.0",
        notes: [
          "N-009: 导出文件包含 identity 数据（不含密码），可用于恢复到空库。",
          "恢复后由工作区 Owner 调用 POST /auth/recovered-users/:userId/reset-password 为恢复用户设置初始密码。",
          "恢复操作会保留原始 ID，确保外键关系一致。",
        ],
      },
      exportedAt: new Date().toISOString(),
    };
  }, { isolationLevel: "repeatable read" });
}

/**
 * N-009: 从导出的 JSON 恢复 workspace 数据到当前 workspace。
 *
 * 恢复策略：
 * - 在单事务中执行，确保原子性
 * - 保留原始 ID，确保外键关系一致
 * - 如果目标 workspace 已有数据，返回冲突错误（不支持合并恢复）
 * - 恢复后需要重新设置用户密码
 * - 恢复后需要调用 POST /search/reindex 重建搜索索引
 */
export async function restoreWorkspace(
  targetWorkspaceId: string,
  data: Record<string, unknown>,
  dryRun = false,
  database: RestoreDatabase = db,
): Promise<{ success: boolean; message: string; dryRun?: boolean; counts?: Record<string, number> }> {
  // 基本校验
  if (!data.workspace || !data.exportManifest) {
    return { success: false, message: "无效的导出文件：缺少 workspace 或 exportManifest 字段" };
  }
  const manifest = data.exportManifest as Record<string, unknown>;
  if (manifest.version !== "2.0") {
    return { success: false, message: "不支持的导出文件版本：仅支持 2.0" };
  }

  // 检查目标 workspace 是否已有业务数据。新工作区本身会包含 Owner 成员，
  // 因而不能以 workspace_members 非空作为冲突依据。
  const [existingNotes, existingSources, existingCards, existingJobs, existingArtifacts] = await Promise.all([
    database.query.notes.findMany({ where: and(eq(notes.workspaceId, targetWorkspaceId), isNull(notes.deletedAt)), limit: 1 }),
    database.query.sources.findMany({ where: eq(sources.workspaceId, targetWorkspaceId), limit: 1 }),
    database.query.learningCards.findMany({ where: eq(learningCards.workspaceId, targetWorkspaceId), limit: 1 }),
    database.query.jobs.findMany({ where: eq(jobs.workspaceId, targetWorkspaceId), limit: 1 }),
    database.query.aiArtifacts.findMany({ where: eq(aiArtifacts.workspaceId, targetWorkspaceId), limit: 1 }),
  ]);
  if (
    existingNotes.length > 0 || existingSources.length > 0 ||
    existingCards.length > 0 || existingJobs.length > 0 || existingArtifacts.length > 0
  ) {
    return {
      success: false,
      message: "目标工作区已有数据，恢复操作不支持合并。请先清空目标工作区或使用新工作区。",
    };
  }

  const counts: Record<string, number> = {};

  if (dryRun) {
    // dry-run 模式：只统计将要恢复的数据量，不实际写入
    counts.users = Array.isArray(data.users) ? data.users.length : 0;
    counts.workspaceMembers = Array.isArray(data.workspaceMembers) ? data.workspaceMembers.length : 0;
    counts.notes = Array.isArray(data.notes) ? data.notes.length : 0;
    counts.noteVersions = Array.isArray(data.noteVersions) ? data.noteVersions.length : 0;
    counts.noteBlocks = Array.isArray(data.noteBlocks) ? data.noteBlocks.length : 0;
    counts.sources = Array.isArray(data.sources) ? data.sources.length : 0;
    counts.sourceSegments = Array.isArray(data.sourceSegments) ? data.sourceSegments.length : 0;
    counts.learningCards = Array.isArray(data.learningCards) ? data.learningCards.length : 0;
    counts.cardKeyPoints = Array.isArray(data.cardKeyPoints) ? data.cardKeyPoints.length : 0;
    counts.evidences = Array.isArray(data.evidences) ? data.evidences.length : 0;
    counts.evidenceOverrides = Array.isArray(data.evidenceOverrides) ? data.evidenceOverrides.length : 0;
    counts.validationQuestions = Array.isArray(data.validationQuestions) ? data.validationQuestions.length : 0;
    counts.validationEvents = Array.isArray(data.validationEvents) ? data.validationEvents.length : 0;
    counts.reviewSchedules = Array.isArray(data.reviewSchedules) ? data.reviewSchedules.length : 0;
    counts.reviewAttempts = Array.isArray(data.reviewAttempts) ? data.reviewAttempts.length : 0;
    counts.understandingEvents = Array.isArray(data.understandingEvents) ? data.understandingEvents.length : 0;
    counts.aiArtifacts = Array.isArray(data.aiArtifacts) ? data.aiArtifacts.length : 0;
    counts.onboardingStates = Array.isArray(data.onboardingStates) ? data.onboardingStates.length : 0;
    // v0.6: 可信掌握闭环新表 dry-run 计数
    counts.validationQuestionRubricItems = Array.isArray(data.validationQuestionRubricItems) ? data.validationQuestionRubricItems.length : 0;
    counts.validationSubmissions = Array.isArray(data.validationSubmissions) ? data.validationSubmissions.length : 0;
    counts.validationSubmissionJobs = Array.isArray(data.validationSubmissionJobs) ? data.validationSubmissionJobs.length : 0;
    counts.validationActionCommands = Array.isArray(data.validationActionCommands) ? data.validationActionCommands.length : 0;
    counts.validationAssistanceExposures = Array.isArray(data.validationAssistanceExposures) ? data.validationAssistanceExposures.length : 0;
    counts.validationPointAssessments = Array.isArray(data.validationPointAssessments) ? data.validationPointAssessments.length : 0;
    counts.schedulingShadowDecisions = Array.isArray(data.schedulingShadowDecisions) ? data.schedulingShadowDecisions.length : 0;
    counts.validationQualitySignals = Array.isArray(data.validationQualitySignals) ? data.validationQualitySignals.length : 0;

    // N-009: dry-run 引用完整性校验
    const refErrors: string[] = [];
    const evidenceIds = new Set((Array.isArray(data.evidences) ? data.evidences : []).map((e: Record<string, unknown>) => e.id as string));
    const cardIds = new Set((Array.isArray(data.learningCards) ? data.learningCards : []).map((c: Record<string, unknown>) => c.id as string));
    const keyPointIds = new Set((Array.isArray(data.cardKeyPoints) ? data.cardKeyPoints : []).map((k: Record<string, unknown>) => k.id as string));
    const questionIds = new Set((Array.isArray(data.validationQuestions) ? data.validationQuestions : []).map((q: Record<string, unknown>) => q.id as string));
    const scheduleIds = new Set((Array.isArray(data.reviewSchedules) ? data.reviewSchedules : []).map((r: Record<string, unknown>) => r.id as string));
    const validationEventIds = new Set((Array.isArray(data.validationEvents) ? data.validationEvents : []).map((v: Record<string, unknown>) => v.id as string));
    const noteVersionIds = new Set((Array.isArray(data.noteVersions) ? data.noteVersions : []).map((v: Record<string, unknown>) => v.id as string));

    // evidence_overrides 引用完整性
    if (Array.isArray(data.evidenceOverrides)) {
      for (const o of data.evidenceOverrides as Record<string, unknown>[]) {
        if (!evidenceIds.has(o.evidenceId as string)) {
          refErrors.push(`evidence_override references missing evidence ${o.evidenceId}`);
        }
      }
    }
    // validation_events 引用完整性
    if (Array.isArray(data.validationEvents)) {
      for (const v of data.validationEvents as Record<string, unknown>[]) {
        if (!cardIds.has(v.cardId as string)) {
          refErrors.push(`validation_event references missing card ${v.cardId}`);
        }
        if (v.keyPointId && !keyPointIds.has(v.keyPointId as string)) {
          refErrors.push(`validation_event references missing key_point ${v.keyPointId}`);
        }
        if (v.questionId && !questionIds.has(v.questionId as string)) {
          refErrors.push(`validation_event references missing question ${v.questionId}`);
        }
      }
    }
    // validation_questions 引用完整性
    if (Array.isArray(data.validationQuestions)) {
      for (const q of data.validationQuestions as Record<string, unknown>[]) {
        if (!cardIds.has(q.cardId as string)) {
          refErrors.push(`validation_question references missing card ${q.cardId}`);
        }
      }
    }
    if (Array.isArray(data.reviewAttempts)) {
      for (const a of data.reviewAttempts as Record<string, unknown>[]) {
        if (!scheduleIds.has(a.reviewScheduleId as string)) {
          refErrors.push(`review_attempt references missing schedule ${a.reviewScheduleId}`);
        }
        if (a.validationEventId && !validationEventIds.has(a.validationEventId as string)) {
          refErrors.push(`review_attempt references missing validation_event ${a.validationEventId}`);
        }
        if (a.validationQuestionId && !questionIds.has(a.validationQuestionId as string)) {
          refErrors.push(`review_attempt references missing question ${a.validationQuestionId}`);
        }
        if (a.keyPointId && !keyPointIds.has(a.keyPointId as string)) {
          refErrors.push(`review_attempt references missing key_point ${a.keyPointId}`);
        }
        if (a.evidenceId && !evidenceIds.has(a.evidenceId as string)) {
          refErrors.push(`review_attempt references missing evidence ${a.evidenceId}`);
        }
        if (a.noteVersionId && !noteVersionIds.has(a.noteVersionId as string)) {
          refErrors.push(`review_attempt references missing note_version ${a.noteVersionId}`);
        }
      }
    }

    if (refErrors.length > 0) {
      return { success: false, message: `dry-run 引用完整性校验失败：${refErrors.slice(0, 5).join("; ")}${refErrors.length > 5 ? ` ...共 ${refErrors.length} 个错误` : ""}`, dryRun: true, counts };
    }

    // v0.6: 可信掌握闭环新表 dry-run 引用完整性校验 (计划 §6.9)
    const submissionIds = new Set((Array.isArray(data.validationSubmissions) ? data.validationSubmissions : []).map((s: Record<string, unknown>) => s.id as string));
    const rubricItemIds = new Set((Array.isArray(data.validationQuestionRubricItems) ? data.validationQuestionRubricItems : []).map((r: Record<string, unknown>) => r.id as string));

    if (Array.isArray(data.validationQuestionRubricItems)) {
      for (const r of data.validationQuestionRubricItems as Record<string, unknown>[]) {
        if (!questionIds.has(r.questionId as string)) {
          refErrors.push(`validation_question_rubric_item references missing question ${r.questionId}`);
        }
        if (r.evidenceId && !evidenceIds.has(r.evidenceId as string)) {
          refErrors.push(`validation_question_rubric_item references missing evidence ${r.evidenceId}`);
        }
      }
    }

    if (Array.isArray(data.validationSubmissions)) {
      for (const s of data.validationSubmissions as Record<string, unknown>[]) {
        if (!cardIds.has(s.cardId as string)) {
          refErrors.push(`validation_submission references missing card ${s.cardId}`);
        }
        if (s.questionId && !questionIds.has(s.questionId as string)) {
          refErrors.push(`validation_submission references missing question ${s.questionId}`);
        }
        if (s.keyPointId && !keyPointIds.has(s.keyPointId as string)) {
          refErrors.push(`validation_submission references missing key_point ${s.keyPointId}`);
        }
      }
    }

    if (Array.isArray(data.validationSubmissionJobs)) {
      for (const j of data.validationSubmissionJobs as Record<string, unknown>[]) {
        if (!submissionIds.has(j.submissionId as string)) {
          refErrors.push(`validation_submission_job references missing submission ${j.submissionId}`);
        }
      }
    }

    if (Array.isArray(data.validationPointAssessments)) {
      for (const p of data.validationPointAssessments as Record<string, unknown>[]) {
        if (!submissionIds.has(p.submissionId as string)) {
          refErrors.push(`validation_point_assessment references missing submission ${p.submissionId}`);
        }
        if (!rubricItemIds.has(p.rubricItemId as string)) {
          refErrors.push(`validation_point_assessment references missing rubric_item ${p.rubricItemId}`);
        }
      }
    }

    if (Array.isArray(data.validationQualitySignals)) {
      for (const q of data.validationQualitySignals as Record<string, unknown>[]) {
        if (!validationEventIds.has(q.validationEventId as string)) {
          refErrors.push(`validation_quality_signal references missing validation_event ${q.validationEventId}`);
        }
      }
    }

    if (refErrors.length > 0) {
      return { success: false, message: `dry-run v0.6 引用完整性校验失败：${refErrors.slice(0, 5).join("; ")}${refErrors.length > 5 ? ` ...共 ${refErrors.length} 个错误` : ""}`, dryRun: true, counts };
    }

    return { success: true, message: "dry-run 验证通过，可以恢复", dryRun: true, counts };
  }

  try {
    await database.transaction(async (tx) => {
      // 1. 恢复 users（不恢复 passwordHash，使用临时密码）
      if (Array.isArray(data.users)) {
        for (const u of data.users) {
          const user = u as Record<string, unknown>;
          const [insertedUser] = await tx
            .insert(users)
            .values({
              id: user.id as string,
              email: user.email as string,
              // 临时密码哈希，用户需要重置
              passwordHash: RECOVERED_PASSWORD_SENTINEL,
              role: (user.role as string) ?? "owner",
              displayName: (user.displayName as string) ?? null,
              avatarUrl: (user.avatarUrl as string) ?? null,
            })
            .onConflictDoNothing()
            .returning({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
            });

          if (insertedUser) {
            // The exported pointer belongs to the source installation and its
            // personal workspace is not part of a single-workspace archive.
            // Give every newly recovered account a valid local personal space
            // instead of committing a user with personal_workspace_id = NULL.
            const [personalWorkspace] = await tx
              .insert(workspaces)
              .values({
                ownerId: insertedUser.id,
                name: generateDefaultWorkspaceName(
                  insertedUser.displayName,
                  insertedUser.email,
                ),
                workspaceType: "personal",
              })
              .returning({ id: workspaces.id });

            await tx
              .update(users)
              .set({ personalWorkspaceId: personalWorkspace.id })
              .where(eq(users.id, insertedUser.id));

            await tx.insert(workspaceMembers).values({
              workspaceId: personalWorkspace.id,
              userId: insertedUser.id,
              role: "owner",
            });

            await tx.insert(onboardingStates).values({
              workspaceId: personalWorkspace.id,
              userId: insertedUser.id,
              version: "v1",
              steps: {},
              status: "pending",
            });
          }
        }
        counts.users = data.users.length;
      }

      // Restore workspace metadata without replacing the target workspace ID
      // or owner. workspaceType is also target identity metadata: copying it
      // could turn an owner's personal workspace into a collaborative one (or
      // vice versa) while personalWorkspaceId still points at the target.
      // Identity references are restored first so aiConsentBy remains valid.
      const exportedWorkspace = data.workspace as Record<string, unknown>;
      await tx
        .update(workspaces)
        .set({
          name: (exportedWorkspace.name as string) || "恢复的工作区",
          aiProvider: (exportedWorkspace.aiProvider as string) ?? "mock",
          aiConsentVersion: (exportedWorkspace.aiConsentVersion as string) ?? null,
          aiConsentAt: exportedWorkspace.aiConsentAt
            ? new Date(exportedWorkspace.aiConsentAt as string)
            : null,
          aiConsentBy: (exportedWorkspace.aiConsentBy as string) ?? null,
          aiDataPolicy: (exportedWorkspace.aiDataPolicy as {
            sendToExternal: boolean;
            sendImageContent: boolean;
            piiDetection: boolean;
            auditLogging: boolean;
          }) ?? { sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true },
        })
        .where(eq(workspaces.id, targetWorkspaceId));

      // 2. 恢复 workspace_members
      if (Array.isArray(data.workspaceMembers)) {
        for (const m of data.workspaceMembers) {
          const member = m as Record<string, unknown>;
          await tx.insert(workspaceMembers).values({
            workspaceId: targetWorkspaceId,
            userId: member.userId as string,
            role: (member.role as string) ?? "member",
            joinedAt: member.joinedAt ? new Date(member.joinedAt as string) : new Date(),
            leftAt: member.leftAt ? new Date(member.leftAt as string) : null,
          }).onConflictDoNothing();
        }
        counts.workspaceMembers = data.workspaceMembers.length;
      }

      // 3. 恢复 sources
      if (Array.isArray(data.sources)) {
        for (const s of data.sources) {
          const source = s as Record<string, unknown>;
          await tx.insert(sources).values({
            id: source.id as string,
            workspaceId: targetWorkspaceId,
            type: source.type as string,
            title: source.title as string,
            origin: (source.origin as string) ?? null,
            status: (source.status as string) ?? "draft",
            metadata: (source.metadata as Record<string, unknown>) ?? {},
            createdBy: source.createdBy as string,
          }).onConflictDoNothing();
        }
        counts.sources = data.sources.length;
      }

      // 4. 恢复 source_segments
      if (Array.isArray(data.sourceSegments)) {
        for (const s of data.sourceSegments) {
          const seg = s as Record<string, unknown>;
          await tx.insert(sourceSegments).values({
            id: seg.id as string,
            sourceId: seg.sourceId as string,
            workspaceId: targetWorkspaceId,
            ordinal: seg.ordinal as number,
            text: seg.text as string,
            charStart: seg.charStart as number,
            charEnd: seg.charEnd as number,
            segmentType: (seg.segmentType as string) ?? "paragraph",
          }).onConflictDoNothing();
        }
        counts.sourceSegments = data.sourceSegments.length;
      }

      // 5. 恢复 notes
      if (Array.isArray(data.notes)) {
        for (const n of data.notes) {
          const note = n as Record<string, unknown>;
          await tx.insert(notes).values({
            id: note.id as string,
            workspaceId: targetWorkspaceId,
            title: note.title as string,
            titleSource: (note.titleSource as string) ?? "auto",
            // note_versions 尚未恢复；先断开环形引用，版本插入后再回填。
            currentVersionId: null,
            sourceId: (note.sourceId as string) ?? null,
            createdBy: note.createdBy as string,
          }).onConflictDoNothing();
        }
        counts.notes = data.notes.length;
      }

      // 6. 恢复 note_versions
      if (Array.isArray(data.noteVersions)) {
        for (const v of data.noteVersions) {
          const ver = v as Record<string, unknown>;
          const contentJson = ver.contentJson as unknown;
          const contentHash = (ver.contentHash as string) ?? computeContentHash(contentJson);
          await tx.insert(noteVersions).values({
            id: ver.id as string,
            noteId: ver.noteId as string,
            workspaceId: targetWorkspaceId,
            versionNo: ver.versionNo as number,
            contentJson,
            contentHash,
            createdBy: ver.createdBy as string,
          }).onConflictDoNothing();
        }
        counts.noteVersions = data.noteVersions.length;
      }

      // notes.current_version_id 通过复合 FK 指向 note_versions。只有父记录
      // 全部存在后才能恢复该引用，同时保留导出文件中的原始 ID。
      if (Array.isArray(data.notes)) {
        for (const n of data.notes) {
          const note = n as Record<string, unknown>;
          const currentVersionId = note.currentVersionId;
          if (typeof currentVersionId !== "string" || currentVersionId.length === 0) continue;
          await tx
            .update(notes)
            .set({ currentVersionId })
            .where(
              and(
                eq(notes.id, note.id as string),
                eq(notes.workspaceId, targetWorkspaceId),
              ),
            );
        }
      }

      // 7. 恢复 note_blocks
      if (Array.isArray(data.noteBlocks)) {
        for (const b of data.noteBlocks) {
          const block = b as Record<string, unknown>;
          await tx.insert(noteBlocks).values({
            id: block.id as string,
            versionId: block.versionId as string,
            workspaceId: targetWorkspaceId,
            ordinal: block.ordinal as number,
            type: block.type as string,
            content: block.content as string,
            sourceRef: (block.sourceRef as Record<string, unknown>) ?? null,
          }).onConflictDoNothing();
        }
        counts.noteBlocks = data.noteBlocks.length;
      }

      // 8. 恢复 ai_artifacts。learning_cards 和 validation_events 都通过
      // 复合 FK 引用它，必须先于这两类子记录插入。
      if (Array.isArray(data.aiArtifacts)) {
        for (const a of data.aiArtifacts) {
          const art = a as Record<string, unknown>;
          await tx.insert(aiArtifacts).values({
            id: art.id as string,
            workspaceId: targetWorkspaceId,
            type: art.type as string,
            inputRefs: art.inputRefs as Record<string, unknown>,
            output: art.output as unknown,
            modelId: art.modelId as string,
            promptVersion: art.promptVersion as string,
            inputHash: (art.inputHash as string) ?? null,
            costTokens: (art.costTokens as number) ?? null,
            status: (art.status as string) ?? "ready",
            // v0.6 扩展字段 (计划 §6.6): parent_artifact_id 用于 draft → repair → final lineage
            parentArtifactId: (art.parentArtifactId as string) ?? null,
          }).onConflictDoNothing();
        }
        counts.aiArtifacts = data.aiArtifacts.length;
      }

      // 9. 恢复 learning_cards
      if (Array.isArray(data.learningCards)) {
        for (const c of data.learningCards) {
          const card = c as Record<string, unknown>;
          await tx.insert(learningCards).values({
            id: card.id as string,
            noteVersionId: card.noteVersionId as string,
            workspaceId: targetWorkspaceId,
            status: (card.status as string) ?? "active",
            schemaJson: card.schemaJson as { title: string; summary: string },
            artifactId: (card.artifactId as string) ?? null,
            supersededByCardId: (card.supersededByCardId as string) ?? null,
          }).onConflictDoNothing();
        }
        counts.learningCards = data.learningCards.length;
      }

      // 10. 恢复 card_key_points
      if (Array.isArray(data.cardKeyPoints)) {
        for (const k of data.cardKeyPoints) {
          const kp = k as Record<string, unknown>;
          await tx.insert(cardKeyPoints).values({
            id: kp.id as string,
            cardId: kp.cardId as string,
            workspaceId: targetWorkspaceId,
            ordinal: kp.ordinal as number,
            claim: kp.claim as string,
            quoteText: kp.quoteText as string,
            segmentRef: (kp.segmentRef as Record<string, unknown>) ?? null,
          }).onConflictDoNothing();
        }
        counts.cardKeyPoints = data.cardKeyPoints.length;
      }

      // 11. 恢复 evidences
      if (Array.isArray(data.evidences)) {
        for (const e of data.evidences) {
          const ev = e as Record<string, unknown>;
          await tx.insert(evidences).values({
            id: ev.id as string,
            workspaceId: targetWorkspaceId,
            keyPointId: ev.keyPointId as string,
            blockId: (ev.blockId as string) ?? null,
            blockOrdinal: (ev.blockOrdinal as number) ?? null,
            quoteText: ev.quoteText as string,
            alignment: (ev.alignment as string) ?? "unaligned",
            alignmentScore: (ev.alignmentScore as number) ?? 0,
            alignmentMethod: (ev.alignmentMethod as string) ?? "fuzzy",
            userOverride: (ev.userOverride as string) ?? null,
          }).onConflictDoNothing();
        }
        counts.evidences = data.evidences.length;
      }

      // 11b. 恢复 evidence_overrides
      if (Array.isArray(data.evidenceOverrides)) {
        for (const o of data.evidenceOverrides) {
          const override = o as Record<string, unknown>;
          await tx.insert(evidenceOverrides).values({
            id: override.id as string,
            evidenceId: override.evidenceId as string,
            userId: override.userId as string,
            workspaceId: targetWorkspaceId,
            override: override.override as string,
            createdAt: override.createdAt ? new Date(override.createdAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.evidenceOverrides = data.evidenceOverrides.length;
      }

      // 11c. 恢复 validation_questions
      if (Array.isArray(data.validationQuestions)) {
        for (const q of data.validationQuestions) {
          const vq = q as Record<string, unknown>;
          await tx.insert(validationQuestions).values({
            id: vq.id as string,
            workspaceId: targetWorkspaceId,
            cardId: vq.cardId as string,
            keyPointId: (vq.keyPointId as string) ?? null,
            noteVersionId: (vq.noteVersionId as string) ?? null,
            questionType: vq.questionType as string,
            question: vq.question as string,
            createdBy: vq.createdBy as string,
            createdAt: vq.createdAt ? new Date(vq.createdAt as string) : new Date(),
            expiresAt: vq.expiresAt ? new Date(vq.expiresAt as string) : null,
            // v0.6 扩展字段 (计划 §6.2)
            userId: (vq.userId as string) ?? null,
            artifactId: (vq.artifactId as string) ?? null,
            generationJobId: (vq.generationJobId as string) ?? null,
            generatorKind: (vq.generatorKind as string) ?? "ai",
            status: (vq.status as string) ?? "active",
            rubricVersion: (vq.rubricVersion as string) ?? null,
            sourceFingerprint: (vq.sourceFingerprint as string) ?? null,
            supersededAt: vq.supersededAt ? new Date(vq.supersededAt as string) : null,
            staleReason: (vq.staleReason as string) ?? null,
            lastUsedAt: vq.lastUsedAt ? new Date(vq.lastUsedAt as string) : null,
            useCount: (vq.useCount as number) ?? 0,
          }).onConflictDoNothing();
        }
        counts.validationQuestions = data.validationQuestions.length;
      }

      // 12. 恢复 validation_events
      if (Array.isArray(data.validationEvents)) {
        for (const v of data.validationEvents) {
          const ve = v as Record<string, unknown>;
          await tx.insert(validationEvents).values({
            id: ve.id as string,
            workspaceId: targetWorkspaceId,
            userId: ve.userId as string,
            cardId: ve.cardId as string,
            keyPointId: (ve.keyPointId as string) ?? null,
            artifactId: (ve.artifactId as string) ?? null,
            question: ve.question as string,
            questionType: ve.questionType as string,
            userAnswer: ve.userAnswer as string,
            outcome: ve.outcome as string,
            confidence: ve.confidence as number,
            feedback: (ve.feedback as ValidationFeedback | null) ?? null,
            questionId: (ve.questionId as string) ?? null,
            // jobs 属于运行态且不在导出清单中，不能恢复悬空 job FK。
            jobId: null,
            // v0.6 扩展字段 (计划 §6.6)
            submissionId: (ve.submissionId as string) ?? null,
            noteVersionId: (ve.noteVersionId as string) ?? null,
            rubricVersion: (ve.rubricVersion as string) ?? null,
            reducerVersion: (ve.reducerVersion as string) ?? null,
            sourceFingerprint: (ve.sourceFingerprint as string) ?? null,
            sourceStatus: (ve.sourceStatus as string) ?? null,
          }).onConflictDoNothing();
        }
        counts.validationEvents = data.validationEvents.length;
      }

      // 13. 恢复 review_schedules
      if (Array.isArray(data.reviewSchedules)) {
        for (const r of data.reviewSchedules) {
          const rev = r as Record<string, unknown>;
          await tx.insert(reviewSchedules).values({
            id: rev.id as string,
            workspaceId: targetWorkspaceId,
            userId: rev.userId as string,
            subjectType: rev.subjectType as string,
            subjectId: rev.subjectId as string,
            validationEventId: (rev.validationEventId as string) ?? null,
            status: (rev.status as string) ?? "pending",
            nextReviewAt: new Date(rev.nextReviewAt as string),
            intervalDays: (rev.intervalDays as number) ?? 1,
            // v0.6 扩展字段 (计划 §6.6)
            keyPointId: (rev.keyPointId as string) ?? null,
            generation: (rev.generation as number) ?? 1,
            policyVersion: (rev.policyVersion as string) ?? null,
            reasonCode: (rev.reasonCode as string) ?? null,
            supersedesScheduleId: (rev.supersedesScheduleId as string) ?? null,
          }).onConflictDoNothing();
        }
        counts.reviewSchedules = data.reviewSchedules.length;
      }

      // 13b. 恢复 review_attempts (LOOP-01/02) — 必须在 review_schedules 之后，
      //      因为 review_attempts.review_schedule_id 外键指向 review_schedules。
      //      answer_text 属于业务数据，随导出文件一起恢复；隐私边界由导出文件
      //      本身的访问控制保证（仅 Owner 可导出/恢复）。
      if (Array.isArray(data.reviewAttempts)) {
        for (const a of data.reviewAttempts) {
          const att = a as Record<string, unknown>;
          await tx.insert(reviewAttempts).values({
            id: att.id as string,
            workspaceId: targetWorkspaceId,
            userId: att.userId as string,
            reviewScheduleId: att.reviewScheduleId as string,
            subjectType: att.subjectType as string,
            subjectId: att.subjectId as string,
            validationEventId: (att.validationEventId as string) ?? null,
            validationQuestionId: (att.validationQuestionId as string) ?? null,
            keyPointId: (att.keyPointId as string) ?? null,
            evidenceId: (att.evidenceId as string) ?? null,
            noteVersionId: (att.noteVersionId as string) ?? null,
            answerType: (att.answerType as string) ?? null,
            answerText: (att.answerText as string) ?? null,
            outcome: (att.outcome as string) ?? null,
            confidence: (att.confidence as number) ?? null,
            skipReason: (att.skipReason as string) ?? null,
            scheduleBeforeIntervalDays: (att.scheduleBeforeIntervalDays as number) ?? null,
            scheduleAfterIntervalDays: (att.scheduleAfterIntervalDays as number) ?? null,
            scheduleReasonCode: (att.scheduleReasonCode as string) ?? null,
            understandingEffect: (att.understandingEffect as string) ?? null,
            nextReviewAt: att.nextReviewAt ? new Date(att.nextReviewAt as string) : null,
            nextScheduleId: (att.nextScheduleId as string) ?? null,
            idempotencyKey: att.idempotencyKey as string,
            status: (att.status as string) ?? "started",
            startedAt: att.startedAt ? new Date(att.startedAt as string) : new Date(),
            completedAt: att.completedAt ? new Date(att.completedAt as string) : null,
            abandonedAt: att.abandonedAt ? new Date(att.abandonedAt as string) : null,
            createdAt: att.createdAt ? new Date(att.createdAt as string) : new Date(),
            updatedAt: att.updatedAt ? new Date(att.updatedAt as string) : new Date(),
            // v0.6 扩展字段 (计划 §6.6)
            evaluationArtifactId: (att.evaluationArtifactId as string) ?? null,
            evaluationStatus: (att.evaluationStatus as string) ?? null,
            assistanceLevel: (att.assistanceLevel as string) ?? null,
            evidenceRevealedAt: att.evidenceRevealedAt ? new Date(att.evidenceRevealedAt as string) : null,
            policyVersion: (att.policyVersion as string) ?? null,
            sourceFingerprint: (att.sourceFingerprint as string) ?? null,
          }).onConflictDoNothing();
        }
        counts.reviewAttempts = data.reviewAttempts.length;
      }

      // 14. 恢复 understanding_events
      if (Array.isArray(data.understandingEvents)) {
        for (const u of data.understandingEvents) {
          const ue = u as Record<string, unknown>;
          await tx.insert(understandingEvents).values({
            id: ue.id as string,
            workspaceId: targetWorkspaceId,
            userId: ue.userId as string,
            subjectType: ue.subjectType as string,
            subjectId: ue.subjectId as string,
            eventType: ue.eventType as string,
            payload: (ue.payload as Record<string, unknown>) ?? {},
          }).onConflictDoNothing();
        }
        counts.understandingEvents = data.understandingEvents.length;
      }

      // ═══ v0.6: 可信掌握闭环新表恢复 (计划 §6.9) ═══
      // 依赖顺序：rubric_items → submissions → submission_jobs, action_commands,
      //           assistance_exposures → point_assessments, shadow_decisions,
      //           quality_signals

      // v0.6-15. 恢复 validation_question_rubric_items (依赖 validation_questions)
      if (Array.isArray(data.validationQuestionRubricItems)) {
        for (const r of data.validationQuestionRubricItems) {
          const ri = r as Record<string, unknown>;
          await tx.insert(validationQuestionRubricItems).values({
            id: ri.id as string,
            workspaceId: targetWorkspaceId,
            questionId: ri.questionId as string,
            ordinal: ri.ordinal as number,
            criterion: ri.criterion as string,
            expectedConcept: ri.expectedConcept as string,
            weight: (ri.weight as number) ?? 1,
            required: (ri.required as boolean) ?? true,
            evidenceId: (ri.evidenceId as string) ?? null,
            evidenceSnapshot: (ri.evidenceSnapshot as Record<string, unknown>) ?? null,
            createdAt: ri.createdAt ? new Date(ri.createdAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationQuestionRubricItems = data.validationQuestionRubricItems.length;
      }

      // v0.6-16. 恢复 validation_submissions (依赖 users, learning_cards, card_key_points)
      // user_answer 属于敏感业务数据，随导出文件恢复；隐私边界由导出文件
      // 本身的访问控制保证（仅 Owner 可导出/恢复）。
      if (Array.isArray(data.validationSubmissions)) {
        for (const s of data.validationSubmissions) {
          const sub = s as Record<string, unknown>;
          await tx.insert(validationSubmissions).values({
            id: sub.id as string,
            workspaceId: targetWorkspaceId,
            userId: sub.userId as string,
            cardId: sub.cardId as string,
            keyPointId: (sub.keyPointId as string) ?? null,
            questionId: (sub.questionId as string) ?? null,
            context: sub.context as string,
            reviewAttemptId: (sub.reviewAttemptId as string) ?? null,
            inputScheduleId: (sub.inputScheduleId as string) ?? null,
            userAnswer: (sub.userAnswer as string) ?? null,
            selfConfidence: (sub.selfConfidence as number) ?? null,
            draftRevision: (sub.draftRevision as number) ?? 0,
            answerHash: (sub.answerHash as string) ?? null,
            answerLockedAt: sub.answerLockedAt ? new Date(sub.answerLockedAt as string) : null,
            assistanceSnapshotExposedAt: sub.assistanceSnapshotExposedAt ? new Date(sub.assistanceSnapshotExposedAt as string) : null,
            assistanceLevel: (sub.assistanceLevel as string) ?? "none",
            evidenceRevealedAt: sub.evidenceRevealedAt ? new Date(sub.evidenceRevealedAt as string) : null,
            sourceFingerprint: (sub.sourceFingerprint as string) ?? null,
            status: (sub.status as string) ?? "question_preparing",
            currentGenerationJobId: (sub.currentGenerationJobId as string) ?? null,
            currentEvaluationJobId: (sub.currentEvaluationJobId as string) ?? null,
            validationEventId: (sub.validationEventId as string) ?? null,
            failureStage: (sub.failureStage as string) ?? null,
            failureCode: (sub.failureCode as string) ?? null,
            terminalReason: (sub.terminalReason as string) ?? null,
            startIdempotencyKey: sub.startIdempotencyKey as string,
            createdAt: sub.createdAt ? new Date(sub.createdAt as string) : new Date(),
            updatedAt: sub.updatedAt ? new Date(sub.updatedAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationSubmissions = data.validationSubmissions.length;
      }

      // v0.6-17. 恢复 validation_submission_jobs (依赖 validation_submissions)
      if (Array.isArray(data.validationSubmissionJobs)) {
        for (const j of data.validationSubmissionJobs) {
          const sj = j as Record<string, unknown>;
          await tx.insert(validationSubmissionJobs).values({
            id: sj.id as string,
            submissionId: sj.submissionId as string,
            phase: sj.phase as string,
            phaseOrdinal: (sj.phaseOrdinal as number) ?? 1,
            jobId: sj.jobId as string,
            retryOfJobId: (sj.retryOfJobId as string) ?? null,
            createdAt: sj.createdAt ? new Date(sj.createdAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationSubmissionJobs = data.validationSubmissionJobs.length;
      }

      // v0.6-18. 恢复 validation_action_commands (依赖 users; submission_id 可空)
      if (Array.isArray(data.validationActionCommands)) {
        for (const c of data.validationActionCommands) {
          const ac = c as Record<string, unknown>;
          await tx.insert(validationActionCommands).values({
            id: ac.id as string,
            workspaceId: targetWorkspaceId,
            userId: ac.userId as string,
            submissionId: (ac.submissionId as string) ?? null,
            action: ac.action as string,
            idempotencyKey: ac.idempotencyKey as string,
            requestHash: ac.requestHash as string,
            responseStatus: (ac.responseStatus as string) ?? "pending",
            responseSnapshot: (ac.responseSnapshot as Record<string, unknown>) ?? null,
            createdAt: ac.createdAt ? new Date(ac.createdAt as string) : new Date(),
            updatedAt: ac.updatedAt ? new Date(ac.updatedAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationActionCommands = data.validationActionCommands.length;
      }

      // v0.6-19. 恢复 validation_assistance_exposures (依赖 users, card_key_points)
      if (Array.isArray(data.validationAssistanceExposures)) {
        for (const e of data.validationAssistanceExposures) {
          const ae = e as Record<string, unknown>;
          await tx.insert(validationAssistanceExposures).values({
            id: ae.id as string,
            workspaceId: targetWorkspaceId,
            userId: ae.userId as string,
            keyPointId: ae.keyPointId as string,
            exposureFingerprint: ae.exposureFingerprint as string,
            lastExposureKind: ae.lastExposureKind as string,
            firstExposedAt: ae.firstExposedAt ? new Date(ae.firstExposedAt as string) : new Date(),
            lastExposedAt: ae.lastExposedAt ? new Date(ae.lastExposedAt as string) : new Date(),
            unassistedEligibleAfter: ae.unassistedEligibleAfter ? new Date(ae.unassistedEligibleAfter as string) : new Date(),
            lastOriginSubmissionId: (ae.lastOriginSubmissionId as string) ?? null,
            inputScheduleId: (ae.inputScheduleId as string) ?? null,
            createdAt: ae.createdAt ? new Date(ae.createdAt as string) : new Date(),
            updatedAt: ae.updatedAt ? new Date(ae.updatedAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationAssistanceExposures = data.validationAssistanceExposures.length;
      }

      // v0.6-20. 恢复 validation_point_assessments (依赖 validation_submissions, validation_question_rubric_items)
      if (Array.isArray(data.validationPointAssessments)) {
        for (const p of data.validationPointAssessments) {
          const pa = p as Record<string, unknown>;
          await tx.insert(validationPointAssessments).values({
            id: pa.id as string,
            workspaceId: targetWorkspaceId,
            userId: pa.userId as string,
            submissionId: pa.submissionId as string,
            rubricItemId: pa.rubricItemId as string,
            verdict: pa.verdict as string,
            assessmentSource: pa.assessmentSource as string,
            confidence: (pa.confidence as number) ?? null,
            rationale: (pa.rationale as string) ?? null,
            answerExcerpt: (pa.answerExcerpt as string) ?? null,
            evidenceSnapshot: (pa.evidenceSnapshot as Record<string, unknown>) ?? null,
            createdAt: pa.createdAt ? new Date(pa.createdAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationPointAssessments = data.validationPointAssessments.length;
      }

      // v0.6-21. 恢复 scheduling_shadow_decisions (依赖 users, card_key_points)
      if (Array.isArray(data.schedulingShadowDecisions)) {
        for (const s of data.schedulingShadowDecisions) {
          const sd = s as Record<string, unknown>;
          await tx.insert(schedulingShadowDecisions).values({
            id: sd.id as string,
            workspaceId: targetWorkspaceId,
            userId: sd.userId as string,
            keyPointId: (sd.keyPointId as string) ?? null,
            sourceType: sd.sourceType as string,
            sourceId: sd.sourceId as string,
            algorithm: sd.algorithm as string,
            algorithmVersion: sd.algorithmVersion as string,
            parametersVersion: sd.parametersVersion as string,
            inputSnapshot: (sd.inputSnapshot as Record<string, unknown>) ?? null,
            predictedDueAt: sd.predictedDueAt ? new Date(sd.predictedDueAt as string) : new Date(),
            stability: (sd.stability as unknown) ?? null,
            difficulty: (sd.difficulty as unknown) ?? null,
            retrievability: (sd.retrievability as unknown) ?? null,
            createdAt: sd.createdAt ? new Date(sd.createdAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.schedulingShadowDecisions = data.schedulingShadowDecisions.length;
      }

      // v0.6-22. 恢复 validation_quality_signals (依赖 users, validation_events)
      if (Array.isArray(data.validationQualitySignals)) {
        for (const q of data.validationQualitySignals) {
          const qs = q as Record<string, unknown>;
          await tx.insert(validationQualitySignals).values({
            id: qs.id as string,
            workspaceId: targetWorkspaceId,
            userId: qs.userId as string,
            validationEventId: qs.validationEventId as string,
            submissionId: (qs.submissionId as string) ?? null,
            reason: qs.reason as string,
            comment: (qs.comment as string) ?? null,
            sourceFingerprint: (qs.sourceFingerprint as string) ?? null,
            rubricVersion: (qs.rubricVersion as string) ?? null,
            reducerVersion: (qs.reducerVersion as string) ?? null,
            policyVersion: (qs.policyVersion as string) ?? null,
            createdAt: qs.createdAt ? new Date(qs.createdAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.validationQualitySignals = data.validationQualitySignals.length;
      }

      // 15. 恢复 onboarding_states (SEC-02/ALPHA-01) — 必须在 users 和
      //     workspace_members 之后，因为外键指向它们。
      if (Array.isArray(data.onboardingStates)) {
        for (const o of data.onboardingStates) {
          const os = o as Record<string, unknown>;
          await tx.insert(onboardingStates).values({
            id: os.id as string,
            workspaceId: targetWorkspaceId,
            userId: os.userId as string,
            version: (os.version as string) ?? "v1",
            steps: (os.steps as Record<string, boolean>) ?? {},
            status: (os.status as string) ?? "pending",
            createdAt: os.createdAt ? new Date(os.createdAt as string) : new Date(),
            updatedAt: os.updatedAt ? new Date(os.updatedAt as string) : new Date(),
          }).onConflictDoNothing();
        }
        counts.onboardingStates = data.onboardingStates.length;
      }

    });

    return {
      success: true,
      message: "恢复成功。请由 Owner 为恢复用户设置初始密码，并调用 POST /search/reindex 重建搜索索引。",
      counts,
    };
  } catch (err) {
    logger.error({ err, targetWorkspaceId }, "workspace restore failed");
    return {
      success: false,
      message: "恢复失败：导入数据无效或与目标工作区不兼容",
    };
  }
}

/**
 * 导出单篇笔记为 Markdown。
 */
export async function exportNoteMarkdown(noteId: string, workspaceId: string) {
  // CONC-03: 不导出已软删除的笔记
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
  });
  if (!note) return null;

  const versionId = note.currentVersionId;
  if (!versionId) return null;

  const blocks = await db.query.noteBlocks.findMany({
    where: eq(noteBlocks.versionId, versionId),
    orderBy: (b, { asc: a }) => [a(b.ordinal)],
  });

  const lines: string[] = [`# ${note.title}`, ""];

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        lines.push(block.content);
        break;
      case "paragraph":
        lines.push(block.content);
        break;
      case "code":
        // R-015: parser 已保留 code fence（```typescript...```），不再二次包裹
        if (block.content.trim().startsWith("```")) {
          lines.push(block.content);
        } else {
          lines.push("```");
          lines.push(block.content);
          lines.push("```");
        }
        break;
      case "quote":
        // R-015: parser 已保留 > 前缀，不再二次添加
        if (block.content.startsWith(">")) {
          lines.push(block.content);
        } else {
          lines.push(block.content.split("\n").map((l) => `> ${l}`).join("\n"));
        }
        break;
      case "list":
        lines.push(block.content);
        break;
      case "image":
        lines.push(block.content);
        break;
      default:
        lines.push(block.content);
    }
    lines.push("");
  }

  return lines.join("\n");
}
