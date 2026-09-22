/**
 * 伴星路由的能力边界契约（fail-closed）。
 *
 * 这一类缺陷在 2026-09-16 审计中被真实发现过：连续历史与
 * `history/search` 会读出会话正文，却只挂 requireSession、没有任何 capability
 * 门禁（已修）。本文件把「开关关闭 → 404；开关开启 → 401」变成逐路由断言，
 * 使「新加一条伴星路由但忘记门禁」或「门禁被顺手删掉」都会立刻变红。
 *
 * 实测存在**两种**门禁风格，断言方式必须分别对待：
 *   A. 模块级 `onRequest` 钩子（memory / pet-profile / daily-summary / journey /
 *      delivery / inbox / bridge）：在认证之前执行 → flag 关闭时**匿名也 404**。
 *   B. 路由级 `preHandler: [requireSession, requireCompanionDialogue]`（dialogue）：
 *      认证先于能力门禁 → 匿名请求恒 401，flag 关闭只对**已认证**调用返回 404。
 *      B 的 404 断言由 routes.test.ts 直接覆盖 preHandler（那里的既有做法），
 *      本文件对 B 只钉住「认证边界不受 flag 影响 + 路由未被删除」。
 *
 * 刻意不覆盖 home-projection / room-profile：它们是已交付的 M2 子集，按
 * desktop-frontend-architecture-and-ipc-contract 的裁决不挂伴星能力开关（只由
 * M2 路由与 session 保护）。这里用「开启/关闭都不得 404」把它们钉住，防止有人
 * 顺手给 M2 端点加 flag 而打断桌面端已交付链路。
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";

const GATED_ENV = [
  "COMPANION_DIALOGUE_V1_ENABLED",
  "COMPANION_JOURNEY_V2",
  "COMPANION_BRIDGE_V2",
  "COMPANION_MEMORY_VECTOR_V1",
  "COMPANION_PET_PROFILE_V1",
  "COMPANION_DAILY_SUMMARY_V1",
] as const;

type Flag = (typeof GATED_ENV)[number];

const savedEnv = new Map<Flag, string | undefined>();

function setFlags(on: readonly Flag[]): void {
  for (const flag of GATED_ENV) {
    if (on.includes(flag)) process.env[flag] = "true";
    else delete process.env[flag];
  }
}

let app: FastifyInstance;

before(async () => {
  for (const flag of GATED_ENV) savedEnv.set(flag, process.env[flag]);
  setFlags([]);
  const { companionConversationRoutes, companionConversationManagementRoutes } =
    await import("./routes.ts");
  const { continuousHistoryRoutes } =
    await import("./continuous-history-routes.ts");
  const { memoryRoutes } = await import("./memory-routes.ts");
  const { petProfileRoutes } = await import("./pet-profile-routes.ts");
  const { dailySummaryRoutes } = await import("./daily-summary-routes.ts");
  const { deliveryTimelineRoutes } = await import("./timeline-routes.ts");
  const { deliveryRoutes } = await import("./delivery-routes.ts");
  const { proactiveInboxRoutes } = await import("./inbox-routes.ts");
  const { companionHomeProjectionRoutes } = await import("./home-projection-routes.ts");
  const { companionBridgeRoutes } = await import("../companion-bridge/routes.ts");
  const { companionJourneyRoutes } = await import("../companion-journey/routes.ts");

  app = Fastify({ logger: false });
  await app.register(companionConversationRoutes);
  await app.register(companionConversationManagementRoutes);
  await app.register(continuousHistoryRoutes);
  await app.register(memoryRoutes);
  await app.register(petProfileRoutes);
  await app.register(dailySummaryRoutes);
  await app.register(deliveryTimelineRoutes);
  await app.register(deliveryRoutes);
  await app.register(proactiveInboxRoutes);
  await app.register(companionHomeProjectionRoutes);
  await app.register(companionBridgeRoutes);
  await app.register(companionJourneyRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const [flag, value] of savedEnv) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});

type RouteCase = {
  label: string;
  flag: Flag;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
};

/** 统一构造 inject 选项：显式标注 InjectOptions 以保住重载（否则响应类型退化为 Chain）。 */
function injectOptions(route: Pick<RouteCase, "method" | "url" | "payload">): InjectOptions {
  const options: InjectOptions = { method: route.method, url: route.url };
  if (route.payload !== undefined) options.payload = route.payload;
  return options;
}

/** A 组：模块级 onRequest 钩子 → flag 关闭时匿名也 404。 */
const ON_REQUEST_GATED_ROUTES: RouteCase[] = [
  { label: "journey: bootstrap", flag: "COMPANION_JOURNEY_V2", method: "GET", url: "/companion/journey/bootstrap" },
  { label: "journey: deliveries timeline", flag: "COMPANION_JOURNEY_V2", method: "GET", url: "/companion/deliveries/timeline" },
  { label: "journey: inbox stream", flag: "COMPANION_JOURNEY_V2", method: "GET", url: "/companion/deliveries/inbox/stream" },
  { label: "journey: delivery lease", flag: "COMPANION_JOURNEY_V2", method: "POST", url: "/companion/deliveries/00000000-0000-4000-8000-000000000000/lease", payload: {} },
  { label: "bridge: publish context", flag: "COMPANION_BRIDGE_V2", method: "POST", url: "/companion/bridge/contexts", payload: {} },
  { label: "memory: list", flag: "COMPANION_MEMORY_VECTOR_V1", method: "GET", url: "/companion/memory" },
  { label: "memory: star map", flag: "COMPANION_MEMORY_VECTOR_V1", method: "GET", url: "/companion/memory/star-map" },
  { label: "pet profile: get", flag: "COMPANION_PET_PROFILE_V1", method: "GET", url: "/companion/pet-profile" },
  { label: "daily summary", flag: "COMPANION_DAILY_SUMMARY_V1", method: "GET", url: "/companion/daily" },
  { label: "daily summary: month marks", flag: "COMPANION_DAILY_SUMMARY_V1", method: "GET", url: "/companion/daily/month?month=2026-09" },
];

/** B 组：preHandler 门禁（认证优先）→ 匿名恒 401，路由必须存在。 */
const PRE_HANDLER_GATED_ROUTES: RouteCase[] = [
  { label: "dialogue: learning-context", flag: "COMPANION_DIALOGUE_V1_ENABLED", method: "GET", url: "/companion/learning-context" },
  { label: "dialogue: continuous history", flag: "COMPANION_DIALOGUE_V1_ENABLED", method: "GET", url: "/companion/history" },
  { label: "dialogue: history search", flag: "COMPANION_DIALOGUE_V1_ENABLED", method: "GET", url: "/companion/history/search?q=x" },
  { label: "dialogue: inbox ensure", flag: "COMPANION_DIALOGUE_V1_ENABLED", method: "POST", url: "/companion/inbox/ensure", payload: {} },
];

describe("A 组：onRequest 能力门禁 → flag 关闭时匿名也 404", () => {
  for (const route of ON_REQUEST_GATED_ROUTES) {
    it(`${route.label} 关闭时 404，开启时落到认证 401`, async () => {
      setFlags([]);
      const closed = await app.inject(injectOptions(route));
      assert.equal(closed.statusCode, 404, `${route.label} 在 ${route.flag} 关闭时必须 404（不得泄漏能力存在性）`);

      setFlags([route.flag]);
      const opened = await app.inject(injectOptions(route));
      assert.equal(
        opened.statusCode,
        401,
        `${route.label} 在 ${route.flag} 开启后必须存在并需要认证（实际 ${opened.statusCode}）`,
      );
    });
  }
});

/**
 * B 组：`requireSession` 在 preHandler 数组里排在能力门禁之前，因此匿名请求恒 401——
 * 这是刻意的顺序（先确认身份再确认能力），不是门禁缺口。flag 关闭时对**已认证**
 * 调用返回 404 的断言由 routes.test.ts 直接调用 requireCompanionDialogue 覆盖。
 * 这里钉住两件事：认证边界不受 flag 影响；这些路由没有被误删（不得 404）。
 */
describe("B 组：preHandler 门禁 → 认证优先，路由必须存在", () => {
  for (const route of PRE_HANDLER_GATED_ROUTES) {
    it(`${route.label} 匿名请求在 flag 开/关下都是 401`, async () => {
      for (const flags of [[], [route.flag]] as const) {
        setFlags(flags as readonly Flag[]);
        const response = await app.inject(injectOptions(route));
        assert.equal(
          response.statusCode,
          401,
          `${route.label} 匿名请求必须 401（认证先于能力门禁）；实际 ${response.statusCode}`,
        );
      }
    });
  }
});

describe("已交付的 M2 端点不挂伴星能力开关", () => {
  // 显式标注 method 字面量类型：`as const` 的元组会让 inject 重载退化。
  const m2Routes: ReadonlyArray<{ method: "GET"; url: string }> = [
    { method: "GET", url: "/companion/home-projection" },
    { method: "GET", url: "/companion/room-profile" },
  ];
  for (const { method, url } of m2Routes) {
    it(`${method} ${url} 在任何伴星开关组合下都不得 404`, async () => {
      for (const flags of [[], GATED_ENV.slice()] as const) {
        setFlags(flags as readonly Flag[]);
        const response = await app.inject({ method, url });
        assert.notEqual(
          response.statusCode,
          404,
          `${method} ${url} 属于已交付的 M2 子集，给它们加 capability 开关会打断桌面端已交付链路`,
        );
        assert.equal(response.statusCode, 401, "匿名请求必须落到认证 401");
      }
    });
  }
});
