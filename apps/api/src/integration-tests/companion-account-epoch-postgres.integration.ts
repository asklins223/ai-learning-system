/**
 * account epoch 的真实递增语义（此前该模块零覆盖）。
 *
 * 合同 §5.2：global off 时账号世代单调递增，客户端据此拒绝「关闭之前」的迟到
 * conversation 事件；从未 global off 的用户世代恒 0。读取端（conversation 事件
 * 写入路径）通过 getCompanionAccountEpoch 取世代，因此这里必须证明：
 *   1. 无行 → 0；
 *   2. global off 是**边沿触发**（`row.globalEnabled && patch.globalEnabled === false`）：
 *      仅 on→off 跃迁递增，重复 off 不递增（避免重复广播），跨跃迁单调递增；
 *   3. 非 global off 的普通 patch 不动世代（否则会把正常改设置误判成撤销信号）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { updateCompanionAccountState } from "../modules/companion-shell/service.ts";
import { getCompanionAccountEpoch } from "../modules/companion-conversation/companion-account-epoch.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——account epoch 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });
const userId = randomUUID();
const workspaceId = randomUUID();

after(async () => {
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await sql`
  INSERT INTO users (id, email, password_hash, role)
  VALUES (${userId}, ${`account-epoch-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')
`;

const readEpoch = () => withWorkspaceTransaction(
  { workspaceId, userId },
  (tx) => getCompanionAccountEpoch(tx, userId),
);

test("从未设置过账号状态 → 世代 0", async () => {
  assert.equal(await readEpoch(), 0);
});

test("首次写入非 global off 的 patch → 世代仍为 0（不误报撤销）", async () => {
  const state = await updateCompanionAccountState(userId, workspaceId, {
    revision: 0,
    presence: { presence: "dnd" },
  });
  assert.equal(state.epoch, 0);
  assert.equal(await readEpoch(), 0);
});

test("global off 是边沿触发：仅 on→off 跃迁递增，重复 off 不重复广播", async () => {
  // 重新开启，回到可写状态（revision 由服务端返回的当前值决定）。
  const opened = await updateCompanionAccountState(userId, workspaceId, {
    revision: 1,
    globalEnabled: true,
  });
  assert.equal(opened.epoch, 0, "开启不递增世代");
  assert.equal(await readEpoch(), 0);

  const firstOff = await updateCompanionAccountState(userId, workspaceId, {
    revision: opened.revision,
    globalEnabled: false,
  });
  assert.ok(firstOff.epoch >= 1, `on→off 跃迁必须递增世代，实际 ${firstOff.epoch}`);
  assert.equal(await readEpoch(), firstOff.epoch, "读取端必须与写入端同源");

  // 已经是 off：重复关闭不是新的撤销事件（不递增、不广播），客户端缓存世代仍有效。
  const repeatedOff = await updateCompanionAccountState(userId, workspaceId, {
    revision: firstOff.revision,
    globalEnabled: false,
  });
  assert.equal(repeatedOff.epoch, firstOff.epoch, "重复 global off 不得递增世代");

  // 但跨跃迁必须单调递增：off → on → off 必须比上一次 off 更大。
  const reopened = await updateCompanionAccountState(userId, workspaceId, {
    revision: repeatedOff.revision,
    globalEnabled: true,
  });
  assert.equal(reopened.epoch, firstOff.epoch, "重新开启不改变世代");

  const secondOff = await updateCompanionAccountState(userId, workspaceId, {
    revision: reopened.revision,
    globalEnabled: false,
  });
  assert.ok(
    secondOff.epoch > firstOff.epoch,
    `第二次 on→off 跃迁必须继续递增（${firstOff.epoch} → ${secondOff.epoch}）`,
  );
  assert.equal(await readEpoch(), secondOff.epoch);
});
