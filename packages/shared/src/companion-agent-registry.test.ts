import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANION_AGENT_TOOL_NAMES,
  validateCompanionAgentToolArguments,
} from "./companion-agent-registry.ts";

test("提醒与导航工具的参数边界：时刻只收挂钟，页面只收白名单", () => {
  assert.equal(validateCompanionAgentToolArguments("companion_schedule_reminder", {
    text: "把疏散路线过一遍",
    fireAtLocal: "2026-09-22 09:00",
  }).success, true);
  // 模型自己换算成 UTC/ISO-Z 一定会差八小时，格式上直接挡住。
  assert.equal(validateCompanionAgentToolArguments("companion_schedule_reminder", {
    text: "早九点",
    fireAtLocal: "2026-09-22T01:00:00.000Z",
  }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_open_page", { page: "today" }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_open_page", { page: "admin" }).success, false);
  // open_page 不接受任何实体 id：带实体的跳转各有工具做归属校验。
  assert.equal(validateCompanionAgentToolArguments("companion_open_page", {
    page: "review", noteId: "11111111-1111-1111-1111-111111111111",
  }).success, false);
});

test("注册表名字唯一（同名工具会让参数校验表静默覆盖前一个）", () => {
  const seen = new Set<string>();
  const duplicates = COMPANION_AGENT_TOOL_NAMES.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  assert.deepEqual(duplicates, []);
  assert.ok(COMPANION_AGENT_TOOL_NAMES.length > 20);
});
