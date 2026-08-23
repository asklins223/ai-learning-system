/**
 * concept_label 确定性派生单测（Plan 23 W1-05 修复）。
 *
 * 覆盖：
 * - 动词前缀剥离（理解/掌握/说明…）
 * - 首个分句切分（逗号/冒号/分号/括号等）
 * - 过短回退与长度上限
 * - deriveConceptLabel 的 publicSummary 兜底
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveConceptLabelFromStatement,
  deriveConceptLabel,
} from "../modules/card-generation-v2/concept-label.ts";

describe("deriveConceptLabelFromStatement", () => {
  it("剥离开头动词前缀并取第一个分句", () => {
    const label = deriveConceptLabelFromStatement(
      "理解牛顿第二定律在质量不变时，加速度与合外力成正比的关系。",
    );
    assert.equal(label, "牛顿第二定律在质量不变时");
  });

  it("无动词前缀的命题直接取首个分句", () => {
    const label = deriveConceptLabelFromStatement(
      "欧姆定律生成验收：同一温度下电阻电流与电压成正比",
    );
    assert.equal(label, "欧姆定律生成验收");
  });

  it("冒号后的补充说明不进入标题", () => {
    const label = deriveConceptLabelFromStatement(
      "掌握间隔重复：通过在不同时间间隔复习材料来增强长期记忆。",
    );
    assert.equal(label, "间隔重复");
  });

  it("首个分句达到最小长度时直接采用", () => {
    const label = deriveConceptLabelFromStatement(
      "光合作用，是植物将光能转化为化学能的过程",
    );
    assert.equal(label, "光合作用");
  });

  it("过短分句回退到剥离后命题的前 24 字", () => {
    // 首个分句只有 2 字 → 回退到剥离后命题前缀（不足 24 字时取全句）。
    const label = deriveConceptLabelFromStatement(
      "记忆，是把信息长期保留的加工过程",
    );
    assert.equal(label, "记忆，是把信息长期保留的加工过程");
  });

  it("清理尾部标点并限制长度", () => {
    const long = deriveConceptLabelFromStatement(
      "理解一个没有标点的超长命题".repeat(20),
    );
    assert.ok(long.length <= 60);
  });

  it("空输入返回空串", () => {
    assert.equal(deriveConceptLabelFromStatement("   "), "");
  });
});

describe("deriveConceptLabel", () => {
  it("statement 可用时优先使用 statement", () => {
    const label = deriveConceptLabel({
      objectiveStatement: "说明牛顿第一定律的内容，即惯性定律",
      publicSummary: "惯性定律指出物体在不受外力时保持静止或匀速直线运动",
    });
    assert.equal(label, "牛顿第一定律的内容");
  });

  it("statement 派生失败时用 publicSummary 兜底", () => {
    const label = deriveConceptLabel({
      objectiveStatement: "、。",
      publicSummary: "掌握质量守恒定律：化学反应前后质量保持不变",
    });
    assert.equal(label, "质量守恒定律");
  });
});
