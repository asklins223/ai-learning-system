/**
 * `TOOL_LABELS` 与工具注册表的**集合相等**断言（39b §9.6 / 39d W2-1）。
 *
 * 为什么需要：她调一个工具时，界面上那行小字取自这张表；**查不到就是「正在处理…」**
 * —— 一句不说明她在做什么的话。这个缺口不会报错、不会崩溃，只会让用户看见一句废话，
 * 所以历史上一直是静默的：39b §9.6 实测 26 条对 31 个工具，缺的 5 个
 * （`pause_learning`／`resume_learning`／`request_hint`／`switch_task_variant`／`plan_route`）
 * 全是"她在替用户改学习状态"的那些——恰恰是最需要一句说明的动作。
 *
 * 判据从注册表现读，**不抄第二份名字清单**：抄一份就等于给漂移留了第二个落点。
 */
import { COMPANION_AGENT_TOOL_NAMES } from "@ailearn/shared/companion-agent-registry";
import { describe, expect, it } from "vitest";

import { TOOL_LABELS } from "./companion-agent-nodes";

describe("工具标签表与注册表集合相等（W2-1）", () => {
  it("每个注册工具都有一句中文说明，且表里没有多余条目", () => {
    const registered = [...COMPANION_AGENT_TOOL_NAMES].sort();
    const labelled = Object.keys(TOOL_LABELS).sort();

    // 正控制：两边都得真的读到东西。任一为空表，下面的差集都会是空的假绿。
    expect(registered.length).toBeGreaterThan(20);
    expect(labelled.length).toBeGreaterThan(20);

    expect(labelled, "注册了但界面上没有说明的工具（用户会看到「正在处理…」）")
      .toEqual(expect.arrayContaining(registered));
    expect(registered, "界面有说明但注册表里已经没有的工具（删工具时的漏网）")
      .toEqual(expect.arrayContaining(labelled));
  });

  it("说明不是空串、不是「正在处理…」本身", () => {
    for (const [tool, label] of Object.entries(TOOL_LABELS)) {
      expect(label.trim().length, `${tool} 的说明是空的`).toBeGreaterThan(0);
      expect(label, `${tool} 把兜底文案当成了自己的说明`).not.toBe("正在处理…");
    }
  });
});
