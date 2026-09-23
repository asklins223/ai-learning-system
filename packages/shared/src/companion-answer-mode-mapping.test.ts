/**
 * doc 34 L15：账号「作答方式」偏好 → Run 启动参数 `responsePreference` 的映射。
 *
 * 这条测试管的是**两端合同不许各自漂移**：映射表写在
 * `companion-shell-contracts.ts` 一处，值域由这里从真实 schema 上读出来比对，
 * 而不是把四个字符串再抄一遍。
 * - 改映射表里的任意一格 → 第 2 条 deepEqual 红；
 * - 映射出一个两端合同都不认的值 → 第 3 条红；
 * - 给 `answerModePreferenceV1Schema` 加一档而忘了映射 → 第 1 条红
 *   （编译期 `satisfies Record<AnswerModePreferenceV1, string>` 也拦，但那样只会
 *   告诉你"少了个键"，这里报出的是少的是哪一档）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerModePreferenceV1Schema,
  answerModeToResponsePreference,
  answerModeToResponsePreferenceTable,
} from "./companion-shell-contracts.ts";
import { learningObjectivePrimaryActionV3Schema } from "./learning-objective-surface-contracts.ts";
import { createLearningRunRequestSchema } from "./learning-run-contracts.ts";

const OBJ = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";

/** 从真实 schema 上取档位列表，不在测试里再抄一份枚举。 */
const ANSWER_MODE_VALUES = answerModePreferenceV1Schema.removeDefault().options;

function createRunActionFixture(responsePreference: string) {
  return {
    kind: "create_run",
    objectiveId: OBJ,
    label: "开始学习",
    start: {
      version: 2,
      originV2: { kind: "card", cardId: CARD, objectiveId: OBJ },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 180,
      responsePreference,
    },
  };
}

test("映射表覆盖了偏好枚举的每一档，一档不多一档不少", () => {
  const enumOptions = [...ANSWER_MODE_VALUES].sort();
  assert.deepEqual(Object.keys(answerModeToResponsePreferenceTable).sort(), enumOptions);
});

test("映射逐格冻结：any=adaptive、silent=structured、voice/text 原样", () => {
  assert.deepEqual(answerModeToResponsePreferenceTable, {
    any: "adaptive",
    voice: "voice",
    text: "text",
    silent: "structured",
  });
});

test("映射出来的每一格都能过目标表面与学习 Run 两端合同", () => {
  for (const preference of ANSWER_MODE_VALUES) {
    const mapped = answerModeToResponsePreference(preference);
    assert.equal(
      createLearningRunRequestSchema.shape.responsePreference.safeParse(mapped).success,
      true,
      `${preference} → ${mapped} 不被 Run 请求合同接受`,
    );
    assert.equal(
      learningObjectivePrimaryActionV3Schema.safeParse(createRunActionFixture(mapped)).success,
      true,
      `${preference} → ${mapped} 不被 Objective 主行动合同接受`,
    );
  }
});

test("偏好真的会改变启动参数：四档映射出四个不同的值", () => {
  const values = ANSWER_MODE_VALUES.map(answerModeToResponsePreference);
  assert.equal(new Set(values).size, values.length, "两档偏好映射成了同一个值");
});
