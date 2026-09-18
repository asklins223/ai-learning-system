import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { companionRoomProfilePatchV1Schema } from "@ailearn/shared/companion-home-contracts";
import { companionHomeProjectionRoutes } from "./home-projection-routes.ts";

/**
 * 行为断言（Fastify 路由表 + inject），不再对源码做正则匹配：
 * 原先两条用例用 readFileSync 断言 `app.get("/companion/...")` 的字面形状，
 * 重构（改引号/换行/抽 helper）就会失效，却对「路由是否真的注册、是否真的
 * 要求认证、是否真的带 private no-store」零覆盖。
 */
test("companion home 只注册三条路由，且额外路径不存在", async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(companionHomeProjectionRoutes);
  await app.ready();

  assert.equal(app.hasRoute({ method: "GET", url: "/companion/home-projection" }), true);
  assert.equal(app.hasRoute({ method: "GET", url: "/companion/room-profile" }), true);
  assert.equal(app.hasRoute({ method: "PATCH", url: "/companion/room-profile" }), true);
  // 未合同化的路径必须不存在（防止顺手多加一个无认证的 companion 端点）。
  assert.equal(app.hasRoute({ method: "POST", url: "/companion/room-profile" }), false);
  assert.equal(app.hasRoute({ method: "GET", url: "/companion/home-profile" }), false);
  assert.equal(app.hasRoute({ method: "DELETE", url: "/companion/room-profile" }), false);

  const unknown = await app.inject({ method: "GET", url: "/companion/home-profile" });
  assert.equal(unknown.statusCode, 404);
});

test("all companion home endpoints reject anonymous requests with private no-store", async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(companionHomeProjectionRoutes);
  await app.ready();

  for (const request of [
    { method: "GET" as const, url: "/companion/home-projection" },
    { method: "GET" as const, url: "/companion/room-profile" },
    {
      method: "PATCH" as const,
      url: "/companion/room-profile",
      payload: { version: 1, revision: 1, equippedEffectId: null },
    },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["www-authenticate"], "Bearer");
    assert.deepEqual(response.json(), { error: "missing token" });
  }
});

/**
 * HTTP 层的 400/409/200 映射（认证请求 → 真实 handler → 真实 Postgres 服务）
 * 由 apps/api/src/integration-tests/companion-home-profile-rls-postgres.integration.ts
 * 端到端断言；本文件只锁住 handler 调用的 strict patch schema 本身，保证
 * "非法 body 必须被拒绝、合法 body 必须放行" 的两侧边界不会静默漂移。
 *
 * 此前这里还有一条用正则断言 handler 源码包含 `companionRoomProfilePatchV1Schema.
 * safeParse` / `ROOM_PROFILE_CAS_CONFLICT` 等字符串的用例：它既不执行 handler，
 * 也无法证明 CAS 错误被映射为 409——真实的 400/409/200 行为已在上面那份集成测试里
 * 覆盖，因此删除。
 */
test("room profile patch schema rejects the malformed bodies the handler maps to 400", () => {
  const invalid: Array<{ label: string; payload: unknown }> = [
    { label: "revision 非正整数", payload: { version: 1, revision: 0, equippedDecorBySlot: { desk: null } } },
    { label: "revision 非整数", payload: { version: 1, revision: 1.5, equippedDecorBySlot: { desk: null } } },
    { label: "未知键", payload: { version: 1, revision: 1, equippedDecorBySlot: { desk: null }, unlockedDecorIds: [] } },
    { label: "缺少任何装备变更", payload: { version: 1, revision: 1 } },
    { label: "空装备对象", payload: { version: 1, revision: 1, equippedDecorBySlot: {} } },
    { label: "version 字面量错误", payload: { version: 2, revision: 1, equippedDecorBySlot: { desk: null } } },
    { label: "未知装饰 id", payload: { version: 1, revision: 1, equippedDecorBySlot: { desk: "keepsake.not-real" } } },
    { label: "未知槽位", payload: { version: 1, revision: 1, equippedDecorBySlot: { ceiling: null } } },
    { label: "body 不是对象", payload: null },
  ];
  for (const { label, payload } of invalid) {
    assert.equal(
      companionRoomProfilePatchV1Schema.safeParse(payload ?? {}).success,
      false,
      label,
    );
  }
});

test("room profile patch schema accepts the equipment patches the handler forwards", () => {
  assert.deepEqual(
    companionRoomProfilePatchV1Schema.parse({
      version: 1,
      revision: 3,
      equippedDecorBySlot: { desk: "keepsake.first-note", shelf: null },
    }),
    {
      version: 1,
      revision: 3,
      equippedDecorBySlot: { desk: "keepsake.first-note", shelf: null },
    },
  );
  assert.equal(
    companionRoomProfilePatchV1Schema.safeParse({
      version: 1,
      revision: 3,
      equippedEffectId: null,
    }).success,
    true,
    "清空效果装备（null）必须被接受",
  );
});
