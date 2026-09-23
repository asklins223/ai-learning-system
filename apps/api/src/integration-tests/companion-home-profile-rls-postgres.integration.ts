/**
 * Companion 首页房间档案真实 PostgreSQL 集成测试。
 *
 * 覆盖三层此前从未真正执行过的行为：
 *   1. 0185 迁移可重复应用，房间档案按 workspace + user 由 RLS 隔离；
 *   2. 服务层 CAS：`patchCompanionRoomProfile` 的 revision 谓词必须在真实 SQL
 *      中求值——并发写入者持锁推进 revision 后，旧 revision 的 UPDATE 匹配
 *      0 行，且绝不覆盖对手写入的装备；
 *   3. HTTP 契约：认证请求穿过真实 handler（真实 zod strict schema），
 *      400 INVALID_REQUEST / 409 ROOM_PROFILE_CAS_CONFLICT /
 *      409 ROOM_PROFILE_EQUIPMENT_REJECTED / 200 strict room-profile body。
 *
 * 运行（本地开发栈；必须使用受限角色，超级用户会绕过 RLS）：
 *   DATABASE_URL_MIGRATOR="postgres://ailearn_migrator:ailearn_dev@127.0.0.1:5432/ailearn" \
 *   DATABASE_URL_API="postgres://ailearn_api:ailearn_dev@127.0.0.1:5432/ailearn" \
 *   node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/companion-home-profile-rls-postgres.integration.ts
 * 或：make test-companion-home-profile-postgres
 *
 * 角色 URL 缺失时本地允许 skip；CI（process.env.CI）必须 fail closed——
 * 本文件已被 ci.yml 的 fresh-migrations job 接入，静默 skip 等于没有覆盖。
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, type TestContext } from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { companionRoomProfileV1Schema } from "@ailearn/shared/companion-home-contracts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { companionHomeProjectionRoutes } from "../modules/companion-conversation/home-projection-routes.ts";
import { patchCompanionRoomProfile } from "../modules/companion-conversation/home-projection-service.ts";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
const SCOPED_URL = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL_WORKER;
const MIGRATION = readFileSync(
  resolve(import.meta.dirname, "../db/migrations/0185_companion_room_profiles.sql"),
  "utf8",
);

type Sql = ReturnType<typeof postgres>;
type DatabaseUrls = { adminUrl: string; scopedUrl: string };

/** 本地缺 URL 时允许跳过；CI 里必须真正执行，否则视为失败。 */
function databaseUrlsOrSkip(t: TestContext): DatabaseUrls | null {
  if (ADMIN_URL && SCOPED_URL) return { adminUrl: ADMIN_URL, scopedUrl: SCOPED_URL };
  const message =
    "DATABASE_URL_MIGRATOR / DATABASE_URL_API 未配置——companion home profile 集成测试无法运行";
  if (process.env.CI === "true") assert.fail(message);
  t.skip(message);
  return null;
}

// db/client.ts 的全局池因 import home-projection-routes/-service 而存在，
// 不关闭会让文件级测试进程的 event loop 非空。
after(async () => {
  await closeDatabase().catch(() => undefined);
});

/** 与 identity/service.ts hashToken 一致（SHA-256 hex）。 */
/**
 * 合同声明的字段清单——从 schema 自己推，避免测试里再手抄一份名单。
 *
 * `companionRoomProfileV1Schema` 是 `strictObject(...).superRefine(...)`，在 zod 3 里
 * 那是 `ZodEffects`：顶层没有 `.shape`，内层才有（直接 `.shape` 会拿到 undefined，
 * `Object.keys(undefined)` 当场抛"Cannot convert undefined or null to object"）。
 * 两种写法都试，**读不到就喊**——不许退化成"两边都是空数组"的假绿。
 */
function declaredRoomProfileKeys(): string[] {
  const asObject = companionRoomProfileV1Schema as unknown as {
    shape?: Record<string, unknown>;
    _def?: { schema?: { shape?: Record<string, unknown> } };
  };
  const shape = asObject.shape ?? asObject._def?.schema?.shape;
  assert.ok(
    shape && Object.keys(shape).length >= 7,
    "读不到 room-profile 合同的 shape，字段对账不能空跑",
  );
  return Object.keys(shape).sort();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// postgres.js 必须通过 `sql.json` 标记结构化 JSON；普通字符串会被再次
// 序列化成 jsonb string，而裸对象既不满足类型合同也不是参数 helper。
const EMPTY_EQUIPPED_SLOT = { desk: null, shelf: null, window: null, rest: null };

async function deleteFixture(admin: Sql, workspaceId: string, userId: string): Promise<void> {
  await admin`DELETE FROM public.companion_room_profiles WHERE workspace_id = ${workspaceId}`
    .catch(() => undefined);
  await admin`DELETE FROM public.sessions WHERE user_id = ${userId}`.catch(() => undefined);
  await admin`DELETE FROM public.workspace_members WHERE workspace_id = ${workspaceId}`
    .catch(() => undefined);
  await admin`DELETE FROM public.workspaces WHERE id = ${workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM public.users WHERE id = ${userId}`.catch(() => undefined);
}

/** 仅需 users + room profile 的服务层夹具（无里程碑 → 不会触发解锁 reconcile）。 */
async function seedRoomProfileFixture(
  admin: Sql,
  options: {
    workspaceId: string;
    userId: string;
    revision: number;
    unlockedDecorIds: readonly string[];
    unlockedEffectIds: readonly string[];
    emailPrefix: string;
  },
): Promise<void> {
  await admin`
    INSERT INTO public.users (id, email, password_hash, role)
    VALUES (${options.userId}, ${`${options.emailPrefix}-${options.userId}@example.test`}, 'test-hash', 'owner')
  `;
  await admin`
    INSERT INTO public.companion_room_profiles
      (workspace_id, user_id, revision, unlocked_decor_ids, equipped_decor_by_slot, unlocked_effect_ids)
    VALUES (
      ${options.workspaceId},
      ${options.userId},
      ${options.revision},
      ${options.unlockedDecorIds as string[]},
      ${admin.json(EMPTY_EQUIPPED_SLOT)}::jsonb,
      ${options.unlockedEffectIds as string[]}
    )
  `;
}

async function readRoomProfileRow(admin: Sql, scope: { workspaceId: string; userId: string }) {
  const rows = await admin`
    SELECT revision, equipped_decor_by_slot, equipped_effect_id
      FROM public.companion_room_profiles
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
  `;
  return rows[0] ?? null;
}

/**
 * 等待 API 事务真正把带 revision 谓词的 UPDATE 发到 PostgreSQL 并阻塞在行锁上，
 * 返回被阻塞语句的原始文本（用于直接断言 WHERE 子句里的 CAS 谓词）。
 */
async function waitForBlockedRoomProfileUpdate(sql: Sql, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 观察者与被阻塞会话同为 ailearn_api 角色，因此 query 文本可见。
    const rows = await sql`
      SELECT query
        FROM pg_stat_activity
       WHERE state = 'active'
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
         AND query ILIKE '%companion_room_profiles%'
       LIMIT 1
    `;
    const query = rows[0]?.query;
    if (typeof query === "string" && query.length > 0) return query;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("房间档案 UPDATE 从未阻塞在行锁上——无法证明 revision 谓词在 SQL 中求值");
}

async function buildCompanionHomeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(companionHomeProjectionRoutes);
  return app;
}

test("0185 applies fresh/repeat and isolates room profiles by workspace and user", async (t) => {
  const urls = databaseUrlsOrSkip(t);
  if (!urls) return;

  const admin = postgres(urls.adminUrl, { max: 1, connect_timeout: 8 });
  const scoped = postgres(urls.scopedUrl, { max: 1, connect_timeout: 8 });
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  try {
    await admin.unsafe(MIGRATION);
    await admin.unsafe(MIGRATION);

    const security = await admin`
      SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE oid = 'public.companion_room_profiles'::regclass
    `;
    assert.equal(security[0]?.relrowsecurity, true);
    assert.equal(security[0]?.relforcerowsecurity, true);

    await admin`
      INSERT INTO public.users (id, email, password_hash, role)
      VALUES
        (${userId}, ${`home-${userId}@example.test`}, 'test-hash', 'owner'),
        (${otherUserId}, ${`home-${otherUserId}@example.test`}, 'test-hash', 'owner')
    `;
    await admin`
      INSERT INTO public.companion_room_profiles (workspace_id, user_id)
      VALUES (${workspaceId}, ${userId})
    `;

    const withoutContext = await scoped`
      SELECT count(*)::int AS count FROM public.companion_room_profiles
    `;
    assert.equal(withoutContext[0]?.count, 0);

    await scoped.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${otherUserId}, true)`;
      const wrongUser = await tx`
        SELECT count(*)::int AS count FROM public.companion_room_profiles
      `;
      assert.equal(wrongUser[0]?.count, 0);
    });

    await scoped.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${otherWorkspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const wrongWorkspace = await tx`
        SELECT count(*)::int AS count FROM public.companion_room_profiles
      `;
      assert.equal(wrongWorkspace[0]?.count, 0);
    });

    await assert.rejects(
      scoped.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${otherWorkspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${userId}, true)`;
        await tx`
          INSERT INTO public.companion_room_profiles (workspace_id, user_id)
          VALUES (${workspaceId}, ${userId})
        `;
      }),
      (error: unknown) => (error as { code?: string }).code === "42501",
      "cross-workspace writes must be rejected by the RLS WITH CHECK policy",
    );

    await scoped.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const own = await tx`
        SELECT count(*)::int AS count FROM public.companion_room_profiles
      `;
      assert.equal(own[0]?.count, 1);
    });
  } finally {
    await deleteFixture(admin, workspaceId, userId);
    await admin`DELETE FROM public.users WHERE id = ${otherUserId}`.catch(() => undefined);
    await Promise.all([admin.end({ timeout: 2 }), scoped.end({ timeout: 2 })]);
  }
});

test("房间档案 PATCH：真实 SQL revision CAS、装备校验与行不可变性", async (t) => {
  const urls = databaseUrlsOrSkip(t);
  if (!urls) return;

  const admin = postgres(urls.adminUrl, { max: 2, connect_timeout: 8 });
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const scope = { workspaceId, userId };

  try {
    await seedRoomProfileFixture(admin, {
      ...scope,
      revision: 3,
      unlockedDecorIds: ["keepsake.first-note"],
      unlockedEffectIds: ["effect.page-ribbon"],
      emailPrefix: "home-service",
    });

    // 1) 过期 revision：服务层前置比较直接拒绝，且不发出任何 UPDATE。
    const stale = await withWorkspaceTransaction(scope, (tx) =>
      patchCompanionRoomProfile(tx, scope, {
        version: 1,
        revision: 2,
        equippedDecorBySlot: { desk: "keepsake.first-note" },
      }));
    assert.deepEqual(stale, { ok: false, reason: "revision_conflict", currentRevision: 3 });
    assert.equal((await readRoomProfileRow(admin, scope))?.revision, 3);

    // 2) 当前 revision：成功且 revision 恰好 +1。
    const applied = await withWorkspaceTransaction(scope, (tx) =>
      patchCompanionRoomProfile(tx, scope, {
        version: 1,
        revision: 3,
        equippedDecorBySlot: { desk: "keepsake.first-note" },
      }));
    assert.equal(applied.ok, true);
    assert.equal(applied.ok ? applied.profile.revision : null, 4);
    assert.equal(
      applied.ok ? applied.profile.equippedDecorBySlot.desk : null,
      "keepsake.first-note",
    );

    const afterApply = await readRoomProfileRow(admin, scope);
    assert.equal(afterApply?.revision, 4);
    assert.equal(afterApply?.equipped_decor_by_slot.desk, "keepsake.first-note");

    // 3) 装备校验：未解锁 / 槽位非法 / 重复装备 → 结构化拒绝且行不变。
    const locked = await withWorkspaceTransaction(scope, (tx) =>
      patchCompanionRoomProfile(tx, scope, {
        version: 1,
        revision: 4,
        equippedDecorBySlot: { rest: "keepsake.first-memory" },
      }));
    assert.deepEqual(locked, {
      ok: false,
      reason: "decor_locked",
      resourceId: "keepsake.first-memory",
      slot: "rest",
    });

    const slotInvalid = await withWorkspaceTransaction(scope, (tx) =>
      patchCompanionRoomProfile(tx, scope, {
        version: 1,
        revision: 4,
        equippedDecorBySlot: { window: "keepsake.first-note" },
      }));
    assert.deepEqual(slotInvalid, {
      ok: false,
      reason: "decor_slot_invalid",
      resourceId: "keepsake.first-note",
      slot: "window",
    });

    // desk 已装备 first-note，同一资源不能再次出现在 shelf。
    const duplicate = await withWorkspaceTransaction(scope, (tx) =>
      patchCompanionRoomProfile(tx, scope, {
        version: 1,
        revision: 4,
        equippedDecorBySlot: { shelf: "keepsake.first-note" },
      }));
    assert.deepEqual(duplicate, {
      ok: false,
      reason: "decor_duplicate",
      resourceId: "keepsake.first-note",
      slot: "shelf",
    });

    const afterRejections = await readRoomProfileRow(admin, scope);
    assert.equal(afterRejections?.revision, 4);
    assert.equal(afterRejections?.equipped_decor_by_slot.desk, "keepsake.first-note");
    assert.equal(afterRejections?.equipped_decor_by_slot.rest, null);
    assert.equal(afterRejections?.equipped_decor_by_slot.shelf, null);
    assert.equal(afterRejections?.equipped_decor_by_slot.window, null);
  } finally {
    await deleteFixture(admin, workspaceId, userId);
    await admin.end({ timeout: 2 });
  }
});

test("并发写入者推进 revision 后，旧 revision 的 UPDATE 匹配 0 行且不覆盖对手写入", async (t) => {
  const urls = databaseUrlsOrSkip(t);
  if (!urls) return;

  const admin = postgres(urls.adminUrl, { max: 2, connect_timeout: 8 });
  const scoped = postgres(urls.scopedUrl, { max: 2, connect_timeout: 8 });
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const scope = { workspaceId, userId };
  let committed = false;

  try {
    await seedRoomProfileFixture(admin, {
      ...scope,
      revision: 5,
      unlockedDecorIds: ["keepsake.first-note", "keepsake.first-review"],
      unlockedEffectIds: ["effect.page-ribbon"],
      emailPrefix: "home-cas",
    });

    // 对手（真实第二连接）先持锁把 revision 5 → 6，并把 rest 装备为 first-review。
    const blocker = await scoped.reserve();
    try {
      await blocker.unsafe("BEGIN");
      await blocker`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await blocker`SELECT set_config('app.user_id', ${userId}, true)`;
      const bumped = await blocker`
        UPDATE public.companion_room_profiles
           SET revision = revision + 1,
               equipped_decor_by_slot = '{"desk":null,"shelf":null,"window":null,"rest":"keepsake.first-review"}'::jsonb
         WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
        RETURNING revision
      `;
      assert.equal(bumped[0]?.revision, 6);

      // 旧 revision(5) 的 PATCH：前置比较通过（MVCC 仍读到 5），UPDATE 带
      // `revision = 5` 谓词发往数据库并阻塞在对手的行锁上。
      const pending = withWorkspaceTransaction(scope, (tx) =>
        patchCompanionRoomProfile(tx, scope, {
          version: 1,
          revision: 5,
          equippedDecorBySlot: { desk: "keepsake.first-note" },
        }));

      const blockedQuery = await waitForBlockedRoomProfileUpdate(scoped);
      assert.match(blockedQuery, /update\s+"companion_room_profiles"/i);
      assert.match(
        blockedQuery,
        /"revision"\s*=\s*\$\d+/,
        "生成的 UPDATE 必须带 revision 相等谓词（CAS），否则并发写入会被覆盖",
      );

      await blocker.unsafe("COMMIT");
      committed = true;

      const result = await pending;
      assert.deepEqual(result, { ok: false, reason: "revision_conflict", currentRevision: 6 });
    } finally {
      if (!committed) await blocker.unsafe("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    const row = await readRoomProfileRow(admin, scope);
    // 旧 revision 的 UPDATE 匹配 0 行：没有第二次自增，也没有覆盖对手写入。
    assert.equal(row?.revision, 6);
    assert.equal(row?.equipped_decor_by_slot.rest, "keepsake.first-review");
    assert.equal(row?.equipped_decor_by_slot.desk, null);
  } finally {
    await deleteFixture(admin, workspaceId, userId);
    await Promise.all([admin.end({ timeout: 2 }), scoped.end({ timeout: 2 })]);
  }
});

test("PATCH /companion/room-profile：认证请求的 400/409/200 由真实 handler 产生", async (t) => {
  const urls = databaseUrlsOrSkip(t);
  if (!urls) return;

  const admin = postgres(urls.adminUrl, { max: 2, connect_timeout: 8 });
  const scoped = postgres(urls.scopedUrl, { max: 2, connect_timeout: 8 });
  const app = await buildCompanionHomeApp();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const token = `room-profile-http-${randomUUID()}`;

  try {
    // 真实 session（Bearer token → requireSession → decodeToken）+ 已知 revision 档案。
    await scoped.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`
        INSERT INTO public.users (id, email, password_hash, role)
        VALUES (${userId}, ${`home-http-${userId}@example.test`}, 'test-hash', 'owner')
      `;
      await tx`
        INSERT INTO public.workspaces (id, name, owner_id)
        VALUES (${workspaceId}, ${`home-${workspaceId.slice(0, 8)}`}, ${userId})
      `;
      await tx`
        INSERT INTO public.workspace_members (workspace_id, user_id, role)
        VALUES (${workspaceId}, ${userId}, 'owner')
      `;
      await tx`
        INSERT INTO public.sessions (token, user_id, workspace_id, expires_at)
        VALUES (${hashToken(token)}, ${userId}, ${workspaceId}, now() + interval '1 hour')
      `;
      await tx`
        INSERT INTO public.companion_room_profiles
          (workspace_id, user_id, revision, unlocked_decor_ids, equipped_decor_by_slot, unlocked_effect_ids)
        VALUES (
          ${workspaceId},
          ${userId},
          1,
          ARRAY['keepsake.first-note']::text[],
          ${tx.json(EMPTY_EQUIPPED_SLOT)}::jsonb,
          ARRAY['effect.page-ribbon']::text[]
        )
      `;
    });

    const auth = { authorization: `Bearer ${token}` };

    // 400 INVALID_REQUEST：真实 body 穿过 handler 的
    // companionRoomProfilePatchV1Schema.safeParse（无任何 stub）。
    const invalidBodies: Array<{ label: string; payload: Record<string, unknown> }> = [
      {
        label: "revision 必须是正整数",
        payload: { version: 1, revision: 0, equippedDecorBySlot: { desk: null } },
      },
      {
        label: "strictObject 拒绝未知键",
        payload: {
          version: 1,
          revision: 1,
          equippedDecorBySlot: { desk: null },
          unlockedDecorIds: ["keepsake.first-note"],
        },
      },
      {
        label: "至少需要一项装备变更",
        payload: { version: 1, revision: 1 },
      },
      {
        label: "version 只接受字面量 1",
        payload: { version: 2, revision: 1, equippedDecorBySlot: { desk: null } },
      },
      {
        label: "未知装饰 id 被 enum 拒绝",
        payload: { version: 1, revision: 1, equippedDecorBySlot: { desk: "keepsake.not-real" } },
      },
      {
        label: "未知槽位被 strictObject 拒绝",
        payload: { version: 1, revision: 1, equippedDecorBySlot: { ceiling: null } },
      },
    ];
    for (const { label, payload } of invalidBodies) {
      const response = await app.inject({
        method: "PATCH",
        url: "/companion/room-profile",
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, 400, label);
      const body = response.json();
      assert.equal(body.error, "INVALID_REQUEST", label);
      assert.equal(body.message, "room profile body invalid", label);
      assert.equal(body.recoverable, false, label);
      assert.equal(body.version, 1, label);
      assert.equal(typeof body.requestId, "string", label);
      assert.equal(response.headers["cache-control"], "private, no-store", label);
    }

    // 409 ROOM_PROFILE_CAS_CONFLICT：服务读到 revision 1，请求携带过期 revision。
    const conflict = await app.inject({
      method: "PATCH",
      url: "/companion/room-profile",
      headers: auth,
      payload: { version: 1, revision: 2, equippedDecorBySlot: { desk: "keepsake.first-note" } },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.headers["cache-control"], "private, no-store");
    const conflictBody = conflict.json();
    assert.equal(conflictBody.error, "ROOM_PROFILE_CAS_CONFLICT");
    assert.equal(conflictBody.message, "revision_conflict");
    assert.equal(conflictBody.recoverable, true);
    assert.equal(conflictBody.currentRevision, 1);
    assert.equal(typeof conflictBody.requestId, "string");

    // 409 ROOM_PROFILE_EQUIPMENT_REJECTED：未解锁装饰（decor_locked）。
    const lockedDecor = await app.inject({
      method: "PATCH",
      url: "/companion/room-profile",
      headers: auth,
      payload: { version: 1, revision: 1, equippedDecorBySlot: { rest: "keepsake.first-memory" } },
    });
    assert.equal(lockedDecor.statusCode, 409);
    const lockedBody = lockedDecor.json();
    assert.equal(lockedBody.error, "ROOM_PROFILE_EQUIPMENT_REJECTED");
    assert.equal(lockedBody.message, "decor_locked");
    assert.equal(lockedBody.recoverable, false);
    assert.equal(lockedBody.resourceId, "keepsake.first-memory");
    assert.equal(lockedBody.slot, "rest");

    // 409 ROOM_PROFILE_EQUIPMENT_REJECTED：槽位非法（decor_slot_invalid）。
    const wrongSlot = await app.inject({
      method: "PATCH",
      url: "/companion/room-profile",
      headers: auth,
      payload: { version: 1, revision: 1, equippedDecorBySlot: { window: "keepsake.first-note" } },
    });
    assert.equal(wrongSlot.statusCode, 409);
    const wrongSlotBody = wrongSlot.json();
    assert.equal(wrongSlotBody.error, "ROOM_PROFILE_EQUIPMENT_REJECTED");
    assert.equal(wrongSlotBody.message, "decor_slot_invalid");
    assert.equal(wrongSlotBody.recoverable, false);
    assert.equal(wrongSlotBody.resourceId, "keepsake.first-note");
    assert.equal(wrongSlotBody.slot, "window");

    // 被拒绝的请求不得改动任何状态。
    const rejectedRead = await app.inject({
      method: "GET",
      url: "/companion/room-profile",
      headers: auth,
    });
    assert.equal(rejectedRead.statusCode, 200);
    assert.equal(rejectedRead.json().revision, 1);
    assert.deepEqual(rejectedRead.json().equippedDecorBySlot, {
      desk: null,
      shelf: null,
      window: null,
      rest: null,
    });

    // 200：当前 revision + 合法槽位 → strict room-profile body，revision 恰好 +1。
    const applied = await app.inject({
      method: "PATCH",
      url: "/companion/room-profile",
      headers: auth,
      payload: { version: 1, revision: 1, equippedDecorBySlot: { desk: "keepsake.first-note" } },
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.headers["cache-control"], "private, no-store");
    const profile = companionRoomProfileV1Schema.parse(applied.json());
    // 字段清单取合同自己那份 shape，不在测试里手抄第二份——手抄那份在 `proactiveMuted`
    // 进合同时就已经悄悄过期过一次（这条用例红的原因与角色无关，谁都没怀疑到自己抄的名单上）。
    // `strictObject` 已经守住"多一个字段当场抛错"，这里守的是"声明的字段一个都不少"。
    assert.deepEqual(
      Object.keys(profile).sort(),
      declaredRoomProfileKeys(),
      "响应字段与合同声明不一致",
    );
    assert.equal(profile.revision, 2);
    assert.deepEqual(profile.unlockedDecorIds, ["keepsake.first-note"]);
    assert.equal(profile.equippedDecorBySlot.desk, "keepsake.first-note");

    const persisted = await readRoomProfileRow(admin, { workspaceId, userId });
    assert.equal(persisted?.revision, 2);
    assert.equal(persisted?.equipped_decor_by_slot.desk, "keepsake.first-note");
  } finally {
    await app.close();
    await deleteFixture(admin, workspaceId, userId);
    await Promise.all([admin.end({ timeout: 2 }), scoped.end({ timeout: 2 })]);
  }
});
