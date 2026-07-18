import { and, asc, eq, inArray } from "drizzle-orm";
import type { ValidationFeedback } from "@ailearn/shared";
import { db } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, sources, sourceSegments } from "../../db/schema/note.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import {
  evidences,
  validationEvents,
  reviewSchedules,
  understandingEvents,
  evidenceOverrides,
  validationQuestions,
} from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { jobs } from "../../db/schema/job.ts";
import { workspaces, workspaceMembers, users } from "../../db/schema/identity.ts";
import { RECOVERED_PASSWORD_SENTINEL } from "../identity/service.ts";

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

    // notes
    const noteRows = await tx.query.notes.findMany({
      where: eq(notes.workspaceId, workspaceId),
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

    return {
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            ownerId: workspace.ownerId,
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
      understandingEvents: understandingEventRows,
      aiArtifacts: aiArtifactRows,
      /**
       * 导出清单：明确哪些数据已包含、哪些未包含。
       * N-009: 新增 users 和 workspaceMembers，导出文件现在可用于恢复。
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
          "understandingEvents",
          "aiArtifacts",
        ],
        excluded: {
          searchDocuments: "可重建 — 调用 POST /search/reindex 即可从主表重建",
          benchmarkReports: "运行态 — 基准测试报告，不随 workspace 导出",
          benchmarkLabels: "运行态 — 人工标注数据，不随 workspace 导出",
          jobs: "运行态 — AI 任务队列，不随 workspace 导出",
          sessions: "安全敏感 — 用户会话令牌，不应导出",
          passwordHashes: "安全敏感 — 用户密码哈希不导出，恢复后需重置密码",
          aiAuditLog: "运行态 — AI 审计日志，不随 workspace 导出",
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

  // 检查目标 workspace 是否已有业务数据。新工作区本身会包含 Owner 成员，
  // 因而不能以 workspace_members 非空作为冲突依据。
  const [existingNotes, existingSources, existingCards, existingJobs, existingArtifacts] = await Promise.all([
    database.query.notes.findMany({ where: eq(notes.workspaceId, targetWorkspaceId), limit: 1 }),
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
    counts.understandingEvents = Array.isArray(data.understandingEvents) ? data.understandingEvents.length : 0;
    counts.aiArtifacts = Array.isArray(data.aiArtifacts) ? data.aiArtifacts.length : 0;

    // N-009: dry-run 引用完整性校验
    const refErrors: string[] = [];
    const evidenceIds = new Set((Array.isArray(data.evidences) ? data.evidences : []).map((e: Record<string, unknown>) => e.id as string));
    const cardIds = new Set((Array.isArray(data.learningCards) ? data.learningCards : []).map((c: Record<string, unknown>) => c.id as string));
    const keyPointIds = new Set((Array.isArray(data.cardKeyPoints) ? data.cardKeyPoints : []).map((k: Record<string, unknown>) => k.id as string));
    const questionIds = new Set((Array.isArray(data.validationQuestions) ? data.validationQuestions : []).map((q: Record<string, unknown>) => q.id as string));

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

    if (refErrors.length > 0) {
      return { success: false, message: `dry-run 引用完整性校验失败：${refErrors.slice(0, 5).join("; ")}${refErrors.length > 5 ? ` ...共 ${refErrors.length} 个错误` : ""}`, dryRun: true, counts };
    }

    return { success: true, message: "dry-run 验证通过，可以恢复", dryRun: true, counts };
  }

  try {
    await database.transaction(async (tx) => {
      // 1. 恢复 users（不恢复 passwordHash，使用临时密码）
      if (Array.isArray(data.users)) {
        for (const u of data.users) {
          const user = u as Record<string, unknown>;
          await tx.insert(users).values({
            id: user.id as string,
            email: user.email as string,
            // 临时密码哈希，用户需要重置
            passwordHash: RECOVERED_PASSWORD_SENTINEL,
            role: (user.role as string) ?? "owner",
          }).onConflictDoNothing();
        }
        counts.users = data.users.length;
      }

      // 2. 恢复 workspace_members
      if (Array.isArray(data.workspaceMembers)) {
        for (const m of data.workspaceMembers) {
          const member = m as Record<string, unknown>;
          await tx.insert(workspaceMembers).values({
            workspaceId: targetWorkspaceId,
            userId: member.userId as string,
            role: (member.role as string) ?? "member",
            joinedAt: member.joinedAt ? new Date(member.joinedAt as string) : new Date(),
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
          await tx.insert(noteVersions).values({
            id: ver.id as string,
            noteId: ver.noteId as string,
            workspaceId: targetWorkspaceId,
            versionNo: ver.versionNo as number,
            contentJson: ver.contentJson as unknown,
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
          }).onConflictDoNothing();
        }
        counts.reviewSchedules = data.reviewSchedules.length;
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

    });

    return {
      success: true,
      message: "恢复成功。请由 Owner 为恢复用户设置初始密码，并调用 POST /search/reindex 重建搜索索引。",
      counts,
    };
  } catch (err) {
    return {
      success: false,
      message: `恢复失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 导出单篇笔记为 Markdown。
 */
export async function exportNoteMarkdown(noteId: string, workspaceId: string) {
  const note = await db.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
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
