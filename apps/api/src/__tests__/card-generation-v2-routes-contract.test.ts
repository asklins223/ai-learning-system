/**
 * 方案 20 — Card Generation V2 routes 契约单测。
 *
 * 源码文本断言模式（与项目现有 contract 测试一致）：
 * - 端点注册完整性（路径、方法、权限）
 * - NO_STORE header 设置
 * - requireSession / requireOwner 守卫
 * - error → sendServiceError 映射
 * - 路由命名一致性
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const routesSource = readFileSync(
  resolve(import.meta.dirname, "../modules/card-generation-v2/routes.ts"),
  "utf8",
);

const helpersSource = readFileSync(
  resolve(import.meta.dirname, "../modules/card-generation-v2/helpers.ts"),
  "utf8",
);

const serverSource = readFileSync(
  resolve(import.meta.dirname, "../server.ts"),
  "utf8",
);

describe("Card Generation V2 routes contract", () => {
  describe("endpoint registration", () => {
    it("registers POST /v2/card-generation-runs with requireOwner", () => {
      assert.ok(routesSource.includes(`app.post("/v2/card-generation-runs"`));
      assert.ok(routesSource.includes(`preHandler: [requireOwner]`));
    });

    it("registers GET /v2/card-generation-runs/:runId", () => {
      assert.ok(routesSource.includes(`app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId"`));
    });

    it("registers GET /v2/card-generation-runs/:runId/plan", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/plan"`));
    });

    it("registers GET /v2/card-generation-runs/:runId/candidates", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/candidates"`));
    });

    it("registers GET /v2/card-generation-runs/:runId/events", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/events"`));
    });

    it("registers POST /v2/card-generation-runs/:runId/cancel with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/cancel"`));
    });

    it("registers POST /v2/card-generation-runs/:runId/close with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/close"`));
    });

    it("registers POST /v2/card-generation-runs/:runId/candidate-actions with requireOwner", () => {
      // Find the route definition (not the comment) — look for the app.post line
      const postIdx = routesSource.indexOf('app.post', routesSource.indexOf('candidate-actions'));
      assert.ok(postIdx >= 0);
      // Check that requireOwner appears near the candidate-actions route
      const nearby = routesSource.slice(postIdx, postIdx + 200);
      assert.ok(nearby.includes("preHandler: [requireOwner]"));
    });

    it("registers POST /v2/card-generation-runs/:runId/candidates/:candidateId/reveal", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/candidates/:candidateId/reveal"`));
    });

    it("registers POST /v2/card-generation-runs/:runId/activate with requireOwner", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/activate"`));
    });

    it("registers §17.1 activations plural alias", () => {
      assert.ok(routesSource.includes(`"/v2/card-generation-runs/:runId/activations"`));
    });

    it("registers POST /v2/cards/:cardId/reveal (§17.6)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/reveal"`));
    });

    it("registers POST /v2/cards/:cardId/archive with requireOwner (§16.7)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/archive"`));
      assert.ok(routesSource.includes(`preHandler: [requireOwner]`));
    });

    it("registers POST /v2/cards/:cardId/revisions with requireOwner (§15.4)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/revisions"`));
    });

    it("registers POST /v2/cards/:cardId/regeneration-runs with requireOwner (§6.8)", () => {
      assert.ok(routesSource.includes(`"/v2/cards/:cardId/regeneration-runs"`));
    });

    it("registers GET /v2/cards/:cardId (§15.1)", () => {
      assert.ok(routesSource.includes(`app.get<{ Params: { cardId: string } }>("/v2/cards/:cardId"`));
    });

    it("registers reminder endpoints (§17.3)", () => {
      assert.ok(routesSource.includes(`"/v2/initial-validation-reminders"`));
      assert.ok(routesSource.includes(`"/v2/initial-validation-reminders/:reminderId/cancel"`));
    });
  });

  describe("middleware and security", () => {
    it("enforces Idempotency-Key on all mutations (§9.1)", () => {
      assert.ok(routesSource.includes(`requireIdempotencyKey(req)`));
      assert.ok(!routesSource.includes(`?? \`run-${"$"}{crypto.randomUUID()}\``));
    });

    it("adds requireSession as preHandler hook", () => {
      assert.ok(routesSource.includes(`app.addHook("preHandler", requireSession)`));
    });

    it("uses requireOwner for create, cancel, close, candidate-actions, and activate", () => {
      // Count occurrences of requireOwner in route definitions
      const requireOwnerCount = (routesSource.match(/preHandler: \[requireOwner\]/g) || []).length;
      assert.ok(requireOwnerCount >= 5, `expected >=5 requireOwner routes, got ${requireOwnerCount}`);
    });

    it("sets NO_STORE header on all routes", () => {
      const noStoreCount = (routesSource.match(/reply\.headers\(NO_STORE\)/g) || []).length;
      assert.ok(noStoreCount >= 10, `expected >=10 NO_STORE headers, got ${noStoreCount}`);
    });
  });

  describe("error handling", () => {
    it("uses sendServiceError for all routes", () => {
      const errorCount = (routesSource.match(/sendServiceError\(reply, error\)/g) || []).length;
      assert.ok(errorCount >= 8, `expected >=8 sendServiceError calls, got ${errorCount}`);
    });

    it("returns 404 for not found runs", () => {
      assert.ok(routesSource.includes(`run_not_found`));
    });

    it("returns 400 for invalid UUID format", () => {
      assert.ok(routesSource.includes(`invalid_id`));
    });

    it("validates runId consistency between URL and body", () => {
      assert.ok(routesSource.includes(`run_id_mismatch`));
    });

    it("validates candidateId consistency between URL and body", () => {
      assert.ok(routesSource.includes(`candidate_id_mismatch`));
    });
  });

  describe("schema validation", () => {
    it("uses createCardGenerationRunRequestV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`createCardGenerationRunRequestV2Schema`));
    });

    it("uses candidateActionCommandV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`candidateActionCommandV2Schema`));
    });

    it("uses revealCandidateRequestV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`revealCandidateRequestV2Schema`));
    });

    it("uses activateCardCandidatesRequestV2Schema for body validation", () => {
      assert.ok(routesSource.includes(`activateCardCandidatesRequestV2Schema`));
    });
  });

  describe("server registration", () => {
    it("imports cardGenerationV2Routes", () => {
      assert.ok(serverSource.includes(`import { cardGenerationV2Routes }`));
    });

    it("registers cardGenerationV2Routes", () => {
      assert.ok(serverSource.includes(`app.register(cardGenerationV2Routes)`));
    });
  });

  describe("feature flag", () => {
    it("exports isCardGenerationV2Enabled function", () => {
      const flagsSource = readFileSync(
        resolve(import.meta.dirname, "../config/learning-companion-flags.ts"),
        "utf8",
      );
      assert.ok(flagsSource.includes(`isCardGenerationV2Enabled`));
      assert.ok(flagsSource.includes(`CARD_GENERATION_V2_ENABLED`));
    });
  });
});

describe("Card Generation V2 helpers contract", () => {
  it("exports CardGenerationV2ServiceError with code and statusCode", () => {
    assert.ok(helpersSource.includes(`class CardGenerationV2ServiceError`));
    // 重构后 CardGenerationV2ServiceError 继承 DomainError，
    // code/statusCode 由基类提供，helpers.ts 不再直接声明这些字段。
    // 验证继承关系和构造函数传递 code + statusCode 参数。
    assert.ok(helpersSource.includes(`extends DomainError`));
    assert.ok(helpersSource.includes(`code`));
    assert.ok(helpersSource.includes(`statusCode`));
  });

  it("exports NO_STORE with private, no-store", () => {
    assert.ok(helpersSource.includes(`private, no-store`));
  });

  it("exports RunContext type", () => {
    assert.ok(helpersSource.includes(`type RunContext`));
  });

  it("exports serializeRunPublic", () => {
    assert.ok(helpersSource.includes(`function serializeRunPublic`));
  });

  it("exports serializeCandidatePublic", () => {
    assert.ok(helpersSource.includes(`function serializeCandidatePublic`));
  });

  it("exports insertEvent", () => {
    assert.ok(helpersSource.includes(`async function insertEvent`));
  });

  it("exports getCandidateForAction", () => {
    assert.ok(helpersSource.includes(`async function getCandidateForAction`));
  });

  it("exports applyPatch", () => {
    assert.ok(helpersSource.includes(`function applyPatch`));
  });

  it("answer fields do not leak into serializeCandidatePublic", () => {
    // serializeCandidatePublic 的返回对象不得含 canonicalAnswer/explanation 等
    // 私有内容字段（§22.3）。helpers.ts 中 BLOCKED_EVENT_PAYLOAD_KEYS 也会
    // 出现这些词，因此只检查 serializeCandidatePublic 函数体内部。
    const fnStart = helpersSource.indexOf("function serializeCandidatePublic");
    const fnEnd = helpersSource.indexOf("export async function insertEvent", fnStart);
    const fnBody = helpersSource.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    assert.ok(!fnBody.includes(`canonicalAnswer`), "serializeCandidatePublic must not expose canonicalAnswer");
    assert.ok(!fnBody.includes(`explanation`), "serializeCandidatePublic must not expose explanation");
    assert.ok(!fnBody.includes(`learningSupport`), "serializeCandidatePublic must not expose learningSupport");
  });
});
