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

// ─── Configuration ────────────────────────────────────────────────────────

const E2E_USER_EMAIL = process.env.E2E_TEST_USER_EMAIL || "e2e-test@ailearn.local";
const E2E_USER_PASSWORD = process.env.E2E_TEST_USER_PASSWORD || "e2e_test_password_2026";

// V1 退役：原固定 E2E 卡 UUID（E2E_CARD_ID / E2E_REVIEW_SCHEDULE_ID）随 V1
// learningCards 数据播种一并移除，V2 卡片/复习场景需要另定标识符。

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

  // V1 退役（E2E seed）：原步骤 4-7 播种 V1 学习卡数据（learningCards /
  // cardKeyPoints / evidences-by-keyPointId / review_schedules-by-keyPointId /
  // validation_questions-by-cardId）。V1 表及其 keyPointId/cardId 列均已删除，
  // 这些旧 V1 卡数据已无意义，故整段移除；基于 V2（learning_cards_v2 /
  // objectives_v2）的 E2E 卡数据播种需另行设计。

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n✅ E2E seed data complete (V1 卡数据已退役):");
  console.log(`   User:       ${E2E_USER_EMAIL}`);
  console.log(`   Workspace:  ${workspaceId}`);
  console.log(`   Note:       ${noteId}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ E2E seed failed:", err);
  process.exit(1);
});
