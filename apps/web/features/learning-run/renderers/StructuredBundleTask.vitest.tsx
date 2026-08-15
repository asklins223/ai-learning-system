import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { StructuredBundleTask } from "./StructuredBundleTask";
import type { LearningTaskPublicV1 } from "../contracts";

afterEach(cleanup);

function bundleTask(): LearningTaskPublicV1 & {
  interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "structured_bundle" }>;
} {
  return {
    taskId: "t1",
    sequence: 1,
    intent: "explain",
    purpose: "practice",
    title: "组合练习",
    prompt: "请解释这个要点",
    targetSummary: "要点",
    interaction: {
      kind: "structured_bundle",
      parts: [
        {
          partId: "part:1",
          interaction: { kind: "ordering", publicTokenIds: ["tok:a", "tok:b"] },
          partTrustCeiling: "practice_only",
          qualificationProfileHash: null,
          labels: { "tok:a": "复习间隔", "tok:b": "决定记忆" },
        },
        {
          partId: "part:2",
          interaction: { kind: "relation_canvas", publicNodeIds: ["node:claim", "node:quote"], allowedEdgeKinds: ["supports"] },
          partTrustCeiling: "practice_only",
          qualificationProfileHash: null,
          labels: { "node:claim": "复习间隔决定记忆", "node:quote": "间隔重复有效" },
        },
      ],
    },
    alternatives: [],
    trustCeiling: "practice_only",
    estimatedActiveSeconds: 60,
    status: "active",
    revision: 1,
  };
}

describe("StructuredBundleTask（§5.3/§12.3）", () => {
  it("两个 part 顺序完成，全部完成后一次提交 bundle Artifact", () => {
    const onIntent = vi.fn();
    render(<StructuredBundleTask task={bundleTask()} onIntent={onIntent} />);

    // part1（排序）未完成 → 提交禁用。
    const submit = screen.getByRole("button", { name: "提交组合作答" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    // 点选两个 token（tap-select-place）。
    fireEvent.click(screen.getByText("复习间隔"));
    fireEvent.click(screen.getByText("决定记忆"));

    // part2（关系）：选 supports 边。
    const supports = screen.getAllByText("supports")[0];
    fireEvent.click(supports);

    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onIntent).toHaveBeenCalledWith({
      kind: "submit_structured_bundle",
      partAnswers: [
        { kind: "ordering", orderedTokenIds: ["tok:a", "tok:b"] },
        { kind: "relation", edges: [{ fromNodeId: "node:claim", toNodeId: "node:quote", edgeKind: "supports" }] },
      ],
    });
  });

  it("part 完成状态经 draft 保存与恢复（§12.7 部分完成只存草稿）", () => {
    const onDraftChange = vi.fn();
    render(<StructuredBundleTask task={bundleTask()} onIntent={vi.fn()} onDraftChange={onDraftChange} />);
    fireEvent.click(screen.getByText("复习间隔"));
    expect(onDraftChange).toHaveBeenCalledWith({
      kind: "structured_bundle",
      partAnswers: [{ kind: "ordering", orderedTokenIds: ["tok:a"] }],
    });

    // 从 draft 恢复（部分完成）：提交仍禁用，part1 显示已选。
    cleanup();
    const draft = {
      kind: "structured_bundle" as const,
      partAnswers: [{ kind: "ordering" as const, orderedTokenIds: ["tok:a", "tok:b"] }],
    };
    render(<StructuredBundleTask task={bundleTask()} onIntent={vi.fn()} draft={draft} />);
    expect((screen.getByRole("button", { name: "提交组合作答" }) as HTMLButtonElement).disabled).toBe(true);
    // 已选 token 在顺序列表中（draft 恢复）。
    expect(screen.getAllByText("复习间隔").length).toBeGreaterThan(0);
  });
});
