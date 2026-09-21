/**
 * author 提示的题型入参契约（2026-09-21 真跑事故复盘）。
 *
 * 事故：有界修复拿了一个即兴拼的、没有 `strategy` 的计划目标替身，
 * `buildAuthorSystemPrompt` 查表落空 → `Cannot read properties of undefined (reading 'label')`
 * → 整条 run 已写的候选与已付费调用作废，而日志里认不出这是题型入参的问题。
 * 修复在 handler 侧（取回真正的计划目标），这里钉的是**提示这一端**：
 * 七种题型都要能建出来，未知题型必须喊明白而不是抛认不出的 TypeError。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAuthorSystemPrompt } from "./prompts.ts";
import { CardStrategyValuesV2 } from "@ailearn/shared/card-generation-v2-contracts";

test("七种题型都建得出提示，配额点名与不点名说的是两句不同的话", () => {
  assert.equal(CardStrategyValuesV2.length, 7);
  for (const strategy of CardStrategyValuesV2) {
    const named = buildAuthorSystemPrompt(strategy, "definition", "single_choice");
    assert.ok(named.includes(`本卡的题型已经定好了：${strategy}`), `题型没写进提示：${strategy}`);
    assert.ok(named.includes("这一批要求本卡必须交出一道 single_choice 练习件"),
      `被点名的卡没有配额那句：${strategy}`);
  }
  const notNamed = buildAuthorSystemPrompt("recall", "definition", null);
  assert.ok(notNamed.includes("本卡不在配额点名之列"));
  assert.ok(!notNamed.includes("必须交出一道"), "没被点名的卡不该出现强制语气");
});

test("未知题型：喊出是哪个值不对，不再抛认不出来的 TypeError", () => {
  assert.throws(
    () => buildAuthorSystemPrompt("not-a-strategy" as never, "definition", null),
    /unknown strategy: not-a-strategy/,
  );
});

/**
 * 选项宽度的下限要写在点名里（2026-09-22 审计）：两批 D6 实测 2 道 `single_choice`
 * 里有 1 道只有 2 个选项——那不是选择题，是装在选择题壳子里的判断题，而点名
 * `single_choice` 的唯一理由就是"要证据化的干扰项"。合同侧不能抬下限
 * （读侧共用同一份 schema，会把已激活的卡当场打断，§46 有实测），所以先在提示里说清。
 */
test("点名选择题时下限进提示；点名判断题时不许出现这句", () => {
  const choice = buildAuthorSystemPrompt("recall", "definition", "single_choice");
  assert.match(choice, /至少 3 个选项/, "点名 single_choice 却没说宽度，作者就交了两选项的\u201c选择题\u201d");
  assert.match(choice, /正确项/, "下限要拆成\u201c1 个正确项 + 至少 2 个干扰项\u201d才有可操作性");

  const trueFalse = buildAuthorSystemPrompt("recall", "boundary", "true_false");
  assert.doesNotMatch(trueFalse, /至少 3 个选项/, "把选择题的宽度要求写给判断题");
  const matching = buildAuthorSystemPrompt("compare", "comparison", "matching");
  assert.doesNotMatch(matching, /至少 3 个选项/, "也写给配对题");
});
