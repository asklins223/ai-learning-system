/**
 * 人格档案（pet profile）的实库契约，此前零覆盖。
 *
 * 该服务是「伴星人格」页面的写入面，三个容易静默出错的地方：
 *   1. revision CAS：并发 PATCH 必须有一个 409，而不是后写覆盖先写；
 *   2. 关系数据保护：familiarity / interactionCount 由关系累积逻辑维护，
 *      改人格（名字/语气/边界）**不得**把它们重置；
 *   3. 作用域隔离：一个用户改人格不得影响同 workspace 的另一个用户。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  PetProfileCasConflictError,
  getPetProfile,
  resetPetProfile,
  upsertPetProfile,
  type PetProfileInput,
} from "../modules/companion-conversation/pet-profile-service.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——pet profile 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });
const userA = randomUUID();
const userB = randomUUID();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const prefix = userA.slice(0, 8);

after(async () => {
  await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await sql`
  INSERT INTO users (id, email, password_hash, role)
  VALUES
    (${userA}, ${`pet-a-${prefix}@example.test`}, 'test-hash', 'owner'),
    (${userB}, ${`pet-b-${prefix}@example.test`}, 'test-hash', 'owner')
`;

const baseInput = (overrides: Partial<PetProfileInput> = {}): PetProfileInput => ({
  presetId: "energetic-cat",
  name: "小伴",
  personalityTags: ["好奇", "克制"],
  speakingStyle: "简短口语",
  examples: [{ text: "要不要试试？" }],
  activeness: "moderate",
  boundaries: { allowPlayful: true, allowNudgeLearning: true, allowVoiceTags: false, catchphrase: null },
  ...overrides,
});

const inTx = <T>(userId: string, workspace: string, run: (tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0]) => Promise<T>) =>
  withWorkspaceTransaction({ workspaceId: workspace, userId }, run);

test("未设置过 → null；首次 upsert 建行并回读一致", async () => {
  const before = await inTx(userA, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userA }));
  assert.equal(before, null);

  const created = await inTx(userA, workspaceId, (tx) =>
    upsertPetProfile(tx, { workspaceId, userId: userA }, baseInput()));
  assert.equal(created.name, "小伴");
  assert.deepEqual(created.personalityTags, ["好奇", "克制"]);
  assert.equal(created.boundaries.allowVoiceTags, false);
  assert.ok(created.revision >= 1, "首次写入必须给出可用的 base revision");

  const read = await inTx(userA, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userA }));
  assert.equal(read?.name, "小伴");
  assert.equal(read?.revision, created.revision);
});

test("revision CAS：过期 revision → PetProfileCasConflictError（route 层 409），正确 revision → revision+1", async () => {
  const current = await inTx(userA, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userA }));
  assert.ok(current);

  // 并发写入者先赢
  const winner = await inTx(userA, workspaceId, (tx) =>
    upsertPetProfile(tx, { workspaceId, userId: userA }, baseInput({ name: "先到的名字", revision: current.revision })));
  assert.equal(winner.revision, current.revision + 1);

  // 落后的写入者用同一个 base revision → 必须失败，而不是覆盖
  await assert.rejects(
    () => inTx(userA, workspaceId, (tx) =>
      upsertPetProfile(tx, { workspaceId, userId: userA }, baseInput({ name: "迟到的名字", revision: current.revision }))),
    (error: unknown) => {
      assert.ok(error instanceof PetProfileCasConflictError, `期望 CAS 冲突，实际 ${String(error)}`);
      assert.equal((error as PetProfileCasConflictError).currentRevision, winner.revision);
      return true;
    },
  );

  const afterConflict = await inTx(userA, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userA }));
  assert.equal(afterConflict?.name, "先到的名字", "冲突写入不得落库");
});

test("省略 revision 表示不做 CAS（最后一次写入生效）", async () => {
  const updated = await inTx(userA, workspaceId, (tx) =>
    upsertPetProfile(tx, { workspaceId, userId: userA }, baseInput({ name: "无 CAS 写入" })));
  assert.equal(updated.name, "无 CAS 写入");
});

test("改人格不重置关系累积（familiarity / interactionCount）", async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userA}, true)`;
    await tx`
      UPDATE pet_profiles SET familiarity = 0.42, interaction_count = 17
      WHERE workspace_id = ${workspaceId} AND user_id = ${userA}
    `;
  });

  const updated = await inTx(userA, workspaceId, (tx) =>
    upsertPetProfile(tx, { workspaceId, userId: userA }, baseInput({ name: "换了名字", speakingStyle: "更简短" })));
  assert.equal(updated.name, "换了名字");
  assert.equal(updated.familiarity, 0.42, "人格更新不得重置熟悉度");
  assert.equal(updated.interactionCount, 17, "人格更新不得重置互动次数");
});

test("作用域隔离：另一个用户 / 另一个 workspace 的档案不受影响", async () => {
  assert.equal(
    (await inTx(userB, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userB })))?.name ?? null,
    null,
    "另一个用户不应看到 A 的档案",
  );

  await inTx(userA, otherWorkspaceId, (tx) =>
    upsertPetProfile(tx, { workspaceId: otherWorkspaceId, userId: userA }, baseInput({ name: "另一个 workspace" })));

  const inMainWorkspace = await inTx(userA, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userA }));
  assert.equal(inMainWorkspace?.name, "换了名字", "其他 workspace 的写入不得串到本 workspace");
});

test("reset 删除档案并回退系统默认；重复 reset 幂等返回 false", async () => {
  assert.equal(await inTx(userA, workspaceId, (tx) => resetPetProfile(tx, { workspaceId, userId: userA })), true);
  assert.equal(
    await inTx(userA, workspaceId, (tx) => getPetProfile(tx, { workspaceId, userId: userA })),
    null,
    "reset 后读取必须回退到系统默认（null）",
  );
  assert.equal(await inTx(userA, workspaceId, (tx) => resetPetProfile(tx, { workspaceId, userId: userA })), false);
});
