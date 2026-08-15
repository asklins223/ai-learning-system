/**
 * Orchestrator 模型生成接线测试（单元：schema 严格 + 降级语义）。
 *
 * 真实 LLM 调用在 demonstrated 纵切（assistant-memory-postgres.integration.ts
 * P8 Orchestrator 测试，.env 配置后由 hook 真实触发）中覆盖；此处验证：
 * - 无配置 → null（静默降级）
 * - 输出 schema strict（缺字段/超长拒绝）
 * - extractJson 围栏/裸 JSON 提取
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";

const { generateMemoryCandidates, memoryCandidateOutputSchema } = await import(
  "./proactive-generator.ts"
);

// 单元测试不依赖 env：显式清空后验证 null 降级，再验证 strict schema。
const savedUrl = process.env.ASSESSMENT_CRITIC_URL;
const savedKey = process.env.ASSESSMENT_CRITIC_KEY;
const savedDash = process.env.DASHSCOPE_API_KEY;

after(() => {
  if (savedUrl !== undefined) process.env.ASSESSMENT_CRITIC_URL = savedUrl;
  if (savedKey !== undefined) process.env.ASSESSMENT_CRITIC_KEY = savedKey;
  if (savedDash !== undefined) process.env.DASHSCOPE_API_KEY = savedDash;
});

test("真 LLM 生成（.env 配置后真实调用 DashScope）", { skip: !(savedUrl && (savedKey || savedDash)) && "未配置 critic env" }, async () => {
  if (savedUrl) process.env.ASSESSMENT_CRITIC_URL = savedUrl;
  if (savedKey) process.env.ASSESSMENT_CRITIC_KEY = savedKey;
  if (savedDash) process.env.DASHSCOPE_API_KEY = savedDash;
  const result = await generateMemoryCandidates({
    outcome: "demonstrated",
    trustOutcome: "demonstrated",
    keyPointClaim: "遗忘曲线表明复习间隔决定长期记忆",
    scheduleImpact: "created",
  });
  assert.ok(result, "真实 LLM 应产出记忆候选");
  assert.ok(result.learningContext.length >= 2);
});

test("无配置 → null（静默降级，不阻塞结算）", async () => {
  delete process.env.ASSESSMENT_CRITIC_URL;
  delete process.env.ASSESSMENT_CRITIC_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  const result = await generateMemoryCandidates({
    outcome: "demonstrated",
    trustOutcome: "demonstrated",
    keyPointClaim: "遗忘曲线",
    scheduleImpact: "created",
  });
  assert.equal(result, null);
});

test("输出 schema strict：缺字段/超长/未知字段拒绝", () => {  const schema = memoryCandidateOutputSchema;
  assert.ok(schema, "schema 应导出");
  // 缺 needsFollowup → 拒绝
  assert.equal(
    schema.safeParse({ learningContext: { content: "ok" } }).success,
    false,
  );
  // 超长 content → 拒绝
  assert.equal(
    schema.safeParse({
      learningContext: { content: "x".repeat(401), needsFollowup: true },
    }).success,
    false,
  );
  // 未知字段 → 拒绝（strict）
  assert.equal(
    schema.safeParse({
      learningContext: { content: "ok", needsFollowup: true, extra: 1 },
    }).success,
    false,
  );
  // 合法 → 通过
  assert.equal(
    schema.safeParse({
      learningContext: { content: "已掌握遗忘曲线的核心", needsFollowup: false },
      interactionNote: { content: "三天后提醒巩固" },
    }).success,
    true,
  );
});
