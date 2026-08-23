/**
 * v0.6 E2E Test Seed Data (计划 §13.3, M4 Gate)
 *
 * Seeds a test workspace with the minimum data required for E2E tests:
 * - 1 test user (e2e-test@ailearn.local)
 * - 1 personal workspace
 * - 1 note with content (3 blocks, each with a quote)
 * - 1 active V2 learning card with a canonical objective
 *   (the old V1 card/key-point tables were removed in the refactor)
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
import {
  learningCardsV2,
  learningCardPublicationRevisionsV2,
  learningCardRevisionsV2,
  learningObjectiveRevisionsV2,
  learningObjectivesV2,
} from "../db/schema/card-generation-v2.ts";

// ─── Configuration ────────────────────────────────────────────────────────

const E2E_USER_EMAIL = process.env.E2E_TEST_USER_EMAIL || "e2e-test@ailearn.local";
const E2E_USER_PASSWORD = process.env.E2E_TEST_USER_PASSWORD || "e2e_test_password_2026";

// Stable V2 identifiers used by the browser suite. The objective id is the
// post-refactor alias for the old keyPointId.
const E2E_CARD_ID = "00000000-0000-0000-0000-000000000001";
const E2E_OBJECTIVE_ID = "00000000-0000-0000-0000-000000000002";

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

  // ── 4. Create the current V2 Objective + Card fixture ────────────────
  // No evidence binding is needed for this smoke fixture: the V2 target
  // snapshot adapter intentionally supports an empty evidence closure.
  const existingCard = await db.query.learningCardsV2.findFirst({
    where: (card, { and, eq }) => and(
      eq(card.workspaceId, workspaceId),
      eq(card.cardId, E2E_CARD_ID),
    ),
  });

  if (!existingCard) {
    const objectiveRevisionId = randomUUID();
    const answerUnitId = "earth-orbit-answer";
    const rubricUnitId = "earth-orbit-rubric";
    const evidenceRefId = randomUUID();
    const canonicalAnswer = {
      kind: "text" as const,
      unit: {
        unitId: answerUnitId,
        text: "The Earth orbits the Sun in approximately 365 days, completing one revolution.",
      },
    };
    const scoringRubric = {
      version: 2 as const,
      units: [{
        rubricUnitId,
        facet: "recall" as const,
        criterion: "States that one Earth revolution around the Sun takes approximately 365 days.",
        required: true,
        answerUnitIds: [answerUnitId],
        evidenceRefIds: [evidenceRefId],
      }],
      passingPolicy: {
        requireAllRequiredUnits: true as const,
        allowContradiction: false as const,
      },
      rubricHash: "f".repeat(64),
    };
    const objectiveFingerprint = "f".repeat(64);
    const objectiveRevisionHash = "e".repeat(64);
    const privatePayloadHash = "d".repeat(64);
    const presentationHash = "c".repeat(64);
    const publicPayloadHash = "b".repeat(64);
    const revealPayloadHash = "a".repeat(64);
    const front = {
      cue: "地球公转",
      context: "太阳系中的周期运动",
      prompt: "请解释地球绕太阳公转一周大约需要多久，以及这段时间代表什么。",
    };

    await db.insert(learningObjectivesV2).values({
      workspaceId,
      objectiveId: E2E_OBJECTIVE_ID,
      semanticIdentityClassId: "e2e:earth-orbit",
      semanticIdentityPolicyVersion: "sem-id-v1",
      semanticTargetFingerprint: objectiveFingerprint,
      lifecycle: "active",
      lifecycleEpoch: 1,
      currentObjectiveRevisionId: objectiveRevisionId,
      currentRevision: 1,
    });
    await db.insert(learningObjectiveRevisionsV2).values({
      workspaceId,
      objectiveRevisionId,
      objectiveId: E2E_OBJECTIVE_ID,
      revision: 1,
      objectiveStatement: "Earth's orbital period",
      publicSummary: "Earth's orbital period",
      conceptLabel: "地球公转周期",
      knowledgeForm: "definition",
      preferredIntents: ["recall"],
      canonicalAnswer,
      learningSupport: {
        explanation: "The Earth takes approximately 365 days to complete one orbit around the Sun.",
      },
      scoringRubric,
      relations: [],
      evidenceBindings: [],
      semanticTargetFingerprint: objectiveFingerprint,
      targetRevisionHash: objectiveRevisionHash,
      privatePayloadHash,
    });
    await db.insert(learningCardsV2).values({
      workspaceId,
      cardId: E2E_CARD_ID,
      objectiveId: E2E_OBJECTIVE_ID,
      noteVersionId,
      cardRevision: 1,
      currentPublicationRevision: 1,
      lifecycle: "active",
      front,
      publicSummary: "Earth's orbital period",
      knowledgeForm: "definition",
      strategy: "recall",
      sourceLabel: "E2E Test Note — Key Science Concepts",
      presentationHash,
    });
    await db.insert(learningCardRevisionsV2).values({
      workspaceId,
      cardRevisionId: randomUUID(),
      cardId: E2E_CARD_ID,
      revision: 1,
      front,
      strategy: "recall",
      presentationHash,
    });
    await db.insert(learningCardPublicationRevisionsV2).values({
      workspaceId,
      cardId: E2E_CARD_ID,
      publicationRevision: 1,
      cardRevision: 1,
      objectiveId: E2E_OBJECTIVE_ID,
      objectiveRevision: 1,
      lifecycleAtPublication: "active",
      publicPayloadHash,
      revealPayloadHash,
    });
    console.log(`  ✓ V2 Card: ${E2E_CARD_ID} (objective ${E2E_OBJECTIVE_ID})`);
  } else {
    console.log(`  ✓ V2 Card already exists: ${E2E_CARD_ID}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n✅ E2E seed data complete (current V2 fixture):");
  console.log(`   User:       ${E2E_USER_EMAIL}`);
  console.log(`   Workspace:  ${workspaceId}`);
  console.log(`   Note:       ${noteId}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ E2E seed failed:", err);
  process.exit(1);
});
