/**
 * v0.6 E2E Test Seed Data (计划 §13.3, M4 Gate)
 *
 * Seeds a test workspace with the minimum data required for E2E tests:
 * - 1 test user (e2e-test@ailearn.local)
 * - 1 personal workspace
 * - 1 note with content (3 blocks, each with a quote)
 * - 1 active card with 3 key points
 * - 3 evidence records (one per key point, all "aligned")
 * - 1 pending review schedule (for review queue E2E)
 * - 1 active validation question (for card validation E2E)
 *
 * The seeded card uses a fixed UUID (00000000-0000-0000-0000-000000000001)
 * so E2E test specs can navigate to it directly.
 *
 * Usage:
 *   SEED_E2E=true DATABASE_URL_API=postgresql://... \
 *     node --import tsx apps/api/src/scripts/seed-e2e-v06.ts
 *
 * Environment variables:
 *   E2E_TEST_USER_EMAIL — test user email (default: e2e-test@ailearn.local)
 *   E2E_TEST_USER_PASSWORD — test user password (default: e2e_test_password_2026)
 */

import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.ts";
import {
  users,
  workspaces,
  workspaceMembers,
} from "../db/schema/identity.ts";
import { notes, noteVersions, noteBlocks } from "../db/schema/note.ts";
import { learningCards, cardKeyPoints } from "../db/schema/card.ts";
import { evidences, reviewSchedules, validationQuestions } from "../db/schema/evidence.ts";
import {
  CardStatus,
  EvidenceAlignment,
  ReviewStatus,
  QuestionStatus,
  GeneratorKind,
} from "@ailearn/shared";

// ─── Configuration ────────────────────────────────────────────────────────

const E2E_USER_EMAIL = process.env.E2E_TEST_USER_EMAIL || "e2e-test@ailearn.local";
const E2E_USER_PASSWORD = process.env.E2E_TEST_USER_PASSWORD || "e2e_test_password_2026";

// Fixed UUID for deterministic E2E navigation
const E2E_CARD_ID = "00000000-0000-0000-0000-000000000001";
const E2E_REVIEW_SCHEDULE_ID = "00000000-0000-0000-0000-000000000002";

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱 Seeding v0.6 E2E test data…");

  // ── 1. Create or reuse test user ──────────────────────────────────────
  const existingUser = await db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, E2E_USER_EMAIL),
  });

  let userId: string;
  if (existingUser) {
    console.log(`  ✓ User already exists: ${E2E_USER_EMAIL}`);
    userId = existingUser.id;
  } else {
    await db.insert(users).values({
      email: E2E_USER_EMAIL,
      passwordHash: bcrypt.hashSync(E2E_USER_PASSWORD, 10),
      role: "owner",
      displayName: "E2E Test User",
    });
    userId = (await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, E2E_USER_EMAIL),
    }))!.id;
    console.log(`  ✓ Created user: ${E2E_USER_EMAIL}`);
  }

  // ── 2. Create or reuse workspace ──────────────────────────────────────
  let workspace = await db.query.workspaces.findFirst({
    where: (w, { eq }) => eq(w.ownerId, userId),
  });

  if (!workspace) {
    await db.insert(workspaces).values({
      name: "E2E Test Workspace",
      ownerId: userId,
    });
    workspace = (await db.query.workspaces.findFirst({
      where: (w, { eq }) => eq(w.ownerId, userId),
    }))!;
  }
  const workspaceId = workspace.id;
  console.log(`  ✓ Workspace: ${workspaceId}`);

  // Ensure workspace membership
  const existingMember = await db.query.workspaceMembers.findFirst({
    where: (wm, { and, eq }) =>
      and(eq(wm.workspaceId, workspaceId), eq(wm.userId, userId)),
  });
  if (!existingMember) {
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId,
      role: "owner",
    });
  }

  // ── 3. Create note with content ───────────────────────────────────────
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const blockIds = [randomUUID(), randomUUID(), randomUUID()];
  const blockTexts = [
    "The earth orbits the sun in approximately 365 days, completing one revolution.",
    "Photosynthesis converts solar energy into chemical energy stored in glucose.",
    "DNA replication is semiconservative: each new helix contains one old and one new strand.",
  ];

  const noteContent = {
    blocks: blockTexts.map((text, i) => ({
      id: blockIds[i],
      type: "paragraph",
      text,
    })),
  };

  // 先插 note（currentVersionId 置空），再插 noteVersions，最后回填
  // currentVersionId——复合 FK (current_version_id, workspace_id) 要求
  // note_versions 先行存在。
  await db.insert(notes).values({
    id: noteId,
    workspaceId,
    title: "E2E Test Note — Key Science Concepts",
    titleSource: "manual",
    createdBy: userId,
  });

  await db.insert(noteVersions).values({
    id: noteVersionId,
    noteId,
    workspaceId,
    versionNo: 1,
    contentJson: noteContent,
    contentHash: `hash-${noteVersionId.slice(0, 8)}`,
    createdBy: userId,
  });

  await db.update(notes)
    .set({ currentVersionId: noteVersionId })
    .where(eq(notes.id, noteId));

  // Create note blocks (referenced by evidences.blockId)
  for (let i = 0; i < blockIds.length; i++) {
    await db.insert(noteBlocks).values({
      id: blockIds[i],
      versionId: noteVersionId,
      workspaceId,
      ordinal: i,
      type: "paragraph",
      content: blockTexts[i],
    });
  }
  console.log(`  ✓ Note: ${noteId} (${blockIds.length} blocks)`);

  // ── 4. Create active card with key points ─────────────────────────────
  // Clean up old E2E card if exists
  await db.delete(learningCards).where(eq(learningCards.id, E2E_CARD_ID));
  await db.delete(reviewSchedules).where(eq(reviewSchedules.id, E2E_REVIEW_SCHEDULE_ID));

  const keyPointIds = [randomUUID(), randomUUID(), randomUUID()];
  const keyPointClaims = [
    "Earth's orbital period is 365 days",
    "Photosynthesis converts light to chemical energy",
    "DNA replication is semiconservative",
  ];

  await db.insert(learningCards).values({
    id: E2E_CARD_ID,
    workspaceId,
    noteVersionId,
    status: CardStatus.ACTIVE,
    schemaJson: {
      title: "E2E Test Card — Science Fundamentals",
      summary: "Three key science concepts for E2E testing",
    },
  });

  for (let i = 0; i < keyPointIds.length; i++) {
    await db.insert(cardKeyPoints).values({
      id: keyPointIds[i],
      cardId: E2E_CARD_ID,
      workspaceId,
      ordinal: i + 1,
      claim: keyPointClaims[i],
      quoteText: blockTexts[i],
      segmentRef: { blockId: blockIds[i], blockOrdinal: i },
    });
  }
  console.log(`  ✓ Card: ${E2E_CARD_ID} (${keyPointIds.length} key points)`);

  // ── 5. Create hard evidence for each key point ────────────────────────
  const evidenceIds = [randomUUID(), randomUUID(), randomUUID()];

  for (let i = 0; i < evidenceIds.length; i++) {
    await db.insert(evidences).values({
      id: evidenceIds[i],
      workspaceId,
      keyPointId: keyPointIds[i],
      blockId: blockIds[i],
      blockOrdinal: i,
      quoteText: blockTexts[i],
      alignment: EvidenceAlignment.ALIGNED,
      alignmentScore: 95,
      alignmentMethod: "manual",
    });
  }
  console.log(`  ✓ Evidence: ${evidenceIds.length} records (all aligned)`);

  // ── 6. Create a pending review schedule for review E2E ────────────────
  const now = new Date();

  await db.insert(reviewSchedules).values({
    id: E2E_REVIEW_SCHEDULE_ID,
    workspaceId,
    userId,
    subjectType: "key_point",
    subjectId: keyPointIds[0],
    keyPointId: keyPointIds[0],
    status: ReviewStatus.PENDING,
    nextReviewAt: now,
    intervalDays: 1,
    generation: 1,
    policyVersion: "discrete-v2",
    reasonCode: "initial_validation",
  });
  console.log(`  ✓ Review schedule: ${E2E_REVIEW_SCHEDULE_ID}`);

  // ── 7. Create an active validation question for the first key point ────
  const questionId = randomUUID();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.insert(validationQuestions).values({
    id: questionId,
    workspaceId,
    userId,
    cardId: E2E_CARD_ID,
    keyPointId: keyPointIds[0],
    noteVersionId,
    questionType: "explain",
    question: "Explain why the earth's orbital period is approximately 365 days.",
    createdBy: userId,
    expiresAt,
    status: QuestionStatus.ACTIVE,
    generatorKind: GeneratorKind.DETERMINISTIC,
    rubricVersion: "rubric-reducer-v1",
    sourceFingerprint: `e2e-fp-${questionId.slice(0, 8)}`,
  });
  console.log(`  ✓ Question: ${questionId} (active, deterministic)`);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n✅ E2E seed data complete:");
  console.log(`   User:       ${E2E_USER_EMAIL}`);
  console.log(`   Password:   ${E2E_USER_PASSWORD}`);
  console.log(`   Card URL:   /cards/${E2E_CARD_ID}`);
  console.log(`   Review URL: /review/${E2E_REVIEW_SCHEDULE_ID}`);
  console.log(`   Validate:   /cards/${E2E_CARD_ID}/validate`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ E2E seed failed:", err);
  process.exit(1);
});
