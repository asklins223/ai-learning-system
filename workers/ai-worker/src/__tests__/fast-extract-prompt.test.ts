import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFastExtractSystemPrompt, buildFastExtractUserMessage } from "../agent/fast-extract-prompt.ts";

const input = {
  noteTitle: "机器学习基础",
  evidence: [
    { refId: "ev-1", text: "监督学习需要带标签的数据" },
    { refId: "ev-2", text: "过拟合可以通过正则化缓解" },
  ],
  requiredBundleIds: ["b-ml", "b-nn"],
};

test("系统 Prompt 包含 Required Bundles 与全局提取范式指示", () => {
  const p = buildFastExtractSystemPrompt(input);
  assert.ok(p.includes("全局提取范式"), "Fast 是全局提取范式");
  assert.ok(p.includes("Required Bundles: b-ml, b-nn"), "列出全部 Required Bundle");
  assert.ok(p.includes("只输出 JSON"), "零冗余输出指示");
  assert.ok(p.includes("untrusted data"), "不可信数据提示");
  assert.ok(p.includes("机器学习基础"), "包含笔记标题");
  assert.ok(p.includes("不进行最终分组"), "边界声明(不分组/不排序)");
});

test("系统 Prompt 不含代码围栏渲染为 JSON 提示", () => {
  const p = buildFastExtractSystemPrompt(input);
  // 输出格式指示存在且为"严格 JSON,无 markdown 代码围栏"
  assert.ok(p.includes("严格 JSON，无 markdown 代码围栏"));
});

test("用户消息按 refId 前缀列出全部证据", () => {
  const m = buildFastExtractUserMessage(input);
  assert.ok(m.includes("[ev-1] 监督学习需要带标签的数据"), "证据带 refId 前缀");
  assert.ok(m.includes("[ev-2] 过拟合可以通过正则化缓解"));
  assert.ok(m.split("\n").length >= 4, "标题行 + 证据行");
});

test("空证据列表用户消息仍合法", () => {
  const m = buildFastExtractUserMessage({ ...input, evidence: [] });
  assert.ok(m.includes("全部证据"), "标题仍在");
  assert.equal(m.split("\n").filter((l) => l.startsWith("[")).length, 0, "无证据行");
});
