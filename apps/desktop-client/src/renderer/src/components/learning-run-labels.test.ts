import { describe, expect, it } from "vitest";
import { indexedPublicLabel, publicLabel } from "./learning-run-labels";

describe("learning run public labels", () => {
  it("uses a trimmed server-provided label", () => {
    expect(publicLabel({ optionA: "  公开选项  " }, "optionA")).toBe("公开选项");
  });

  it("uses an ordinal user label when a public label is missing", () => {
    expect(indexedPublicLabel(undefined, ["internal-a", "internal-b"], "internal-b", "选项")).toBe("选项 2");
    expect(indexedPublicLabel(undefined, ["internal-a", "internal-b"], "internal-b", "选项")).not.toContain("internal-b");
  });

  it("treats a blank public label as missing", () => {
    expect(indexedPublicLabel({ "internal-a": "   " }, ["internal-a"], "internal-a", "节点")).toBe("节点 1");
  });

  it("fails closed for an unknown identifier", () => {
    expect(indexedPublicLabel(undefined, ["known"], "unknown", "元素")).toBe("元素");
    expect(indexedPublicLabel(undefined, ["known"], "unknown", "元素")).not.toContain("unknown");
  });
});
