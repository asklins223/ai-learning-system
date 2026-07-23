import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseQuestionType,
  buildValidationPrompt,
} from "../validation-question";

describe("validation question generation (v8)", () => {
  describe("chooseQuestionType", () => {
    it("prefers 'explain' for causal claims with '之所以...是因为'", () => {
      const claim = "认知偏差之所以难以自纠，是因为监督通道存在惰性";
      const type = chooseQuestionType(claim, 0);
      assert.equal(type, "explain");
    });

    it("prefers 'apply' for conditional claims with '当...时'", () => {
      const claim = "当缓存值来源复杂时，写路径应淘汰缓存";
      const type = chooseQuestionType(claim, 0);
      assert.equal(type, "apply");
    });

    it("prefers 'apply' for claims with '如果/若'", () => {
      const claim = "如果并发读在写入前回填旧值，可能导致不一致";
      const type = chooseQuestionType(claim, 0);
      assert.equal(type, "apply");
    });

    it("prefers 'apply' for claims with '即便/即使'", () => {
      const claim = "即便主体明知数值无关，仍会受先前输入影响";
      const type = chooseQuestionType(claim, 0);
      assert.equal(type, "apply");
    });

    it("prefers 'explain' for mechanism claims with '通过/使得'", () => {
      const claim = "通过节点级分裂与合并维持动态平衡";
      const type = chooseQuestionType(claim, 0);
      assert.equal(type, "explain");
    });

    it("falls back to index-based rotation for generic claims", () => {
      const claim = "索引是数据库的重要组件";
      assert.equal(chooseQuestionType(claim, 0), "explain");
      assert.equal(chooseQuestionType(claim, 1), "example");
      assert.equal(chooseQuestionType(claim, 2), "apply");
    });
  });

  describe("buildValidationPrompt - conclusion hiding", () => {
    it("strips conclusive verbs from colon-separated claims", () => {
      const claim =
        "锚定效应揭示了直觉通道对任意先验信息的不可抑制性：即便主体明知数值与问题无关，先前的数字输入仍会系统性地扭曲后续估计";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.includes("不可抑制性"),
        "prompt must not contain the conclusive verb's object",
      );
      assert.ok(
        !prompt.includes("系统性"),
        "prompt must not reveal the consequence",
      );
    });

    it("strips causative verbs '使/让/令'", () => {
      const claim =
        "叶子层的链表连接使范围查询退化为顺序扫描，无需回溯内部节点，这是 B+ 树相比 B 树在区间检索场景下的结构性优势";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.includes("退化为顺序扫描"),
        "prompt must not contain the causative verb's object",
      );
      assert.ok(
        !prompt.includes("结构性优势"),
        "prompt must not reveal the summary conclusion",
      );
    });

    it("strips '这是...' summary clauses", () => {
      const claim =
        "叶子层的链表连接使范围查询退化为顺序扫描，无需回溯内部节点，这是 B+ 树的结构性优势";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.includes("这是"),
        "prompt must not contain '这是' summary",
      );
    });

    it("extracts topic from '之所以...是因为' structure", () => {
      const claim =
        "认知偏差之所以难以自纠，是因为监督通道（系统2）本身存在惰性";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        prompt.includes("认知偏差"),
        "prompt should contain the topic before '之所以'",
      );
      assert.ok(
        !prompt.includes("是因为"),
        "prompt must not contain the reason",
      );
    });

    it("does not reveal the claim conclusion in colon-separated claims", () => {
      const claim =
        "写后淘汰策略在并发场景下存在竞态窗口：读请求回填旧值与写请求淘汰缓存的时序不确定，可能导致旧值重新驻留缓存";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        prompt.includes("竞态窗口"),
        "prompt should contain the topic before colon",
      );
      assert.ok(
        !prompt.includes("旧值重新驻留"),
        "prompt should not reveal the consequence",
      );
    });
  });

  describe("buildValidationPrompt - existing tests compatibility", () => {
    it("does not include the full claim conclusion in the prompt", () => {
      const claim =
        "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新，以避免缓存与数据库之间的值不一致";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.includes("以避免缓存与数据库之间的值不一致"),
        "prompt must not contain the claim's conclusion",
      );
      assert.ok(
        !prompt.includes("写路径应淘汰缓存而非就地更新"),
        "prompt must not contain the claim's recommendation",
      );
    });

    it("provides enough context for the user to understand the question", () => {
      const claim =
        "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新，以避免缓存与数据库之间的值不一致";
      const { prompt } = buildValidationPrompt(claim, 0);
      // The context (condition) should be visible so user knows what's being asked
      assert.ok(
        prompt.includes("缓存值"),
        "prompt should contain the core topic for context",
      );
      assert.ok(
        prompt.includes("当"),
        "prompt should contain the conditional context",
      );
    });

    it("returns the claim directly if it is already a question", () => {
      const claim = "什么是 Cache Aside 模式？";
      const { type, prompt } = buildValidationPrompt(claim, 0);
      assert.equal(prompt, claim);
      assert.equal(type, "explain");
    });

    it("generates explain-type prompt for mechanism claims", () => {
      const claim =
        "通过节点级分裂与合并维持动态平衡，溢出时中间键值上移至父节点";
      const { type, prompt } = buildValidationPrompt(claim, 0);
      assert.equal(type, "explain");
      assert.ok(
        prompt.includes("原理"),
        "explain prompt should ask about principles",
      );
    });

    it("generates apply-type prompt for conditional claims", () => {
      const claim =
        "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新";
      const { type, prompt } = buildValidationPrompt(claim, 0);
      assert.equal(type, "apply");
      assert.ok(
        prompt.includes("忽视") || prompt.includes("重要"),
        "apply prompt should ask about importance or consequences",
      );
    });

    it("generates natural question for conditional claims", () => {
      const claim =
        "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新，以避免缓存与数据库之间的值不一致";
      const { prompt } = buildValidationPrompt(claim, 0);
      // Should not use the old generic "解释以下概念的核心原理" template
      assert.ok(
        !prompt.includes("以下概念"),
        "prompt should not use generic 'concept' template",
      );
    });

    it("generates natural question for mechanism claims with dash separator", () => {
      const claim =
        "将索引数据与路由数据分离存储——路由节点仅负责导航、数据全部聚集在叶子层——能显著提升树的最大扇出";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        prompt.includes("分离存储"),
        "prompt should contain the strategy name",
      );
      assert.ok(
        !prompt.includes("显著提升"),
        "prompt should not reveal the conclusion",
      );
    });

    it("strips causal conclusion clauses", () => {
      const claim =
        "空值的 TTL 必须短于真实数据的创建周期，否则会因过期空值阻塞后续合法读取";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.includes("否则"),
        "prompt should not contain the consequence clause",
      );
      assert.ok(
        !prompt.includes("阻塞后续合法读取"),
        "prompt should not reveal the specific consequence",
      );
    });

    it("handles short claims gracefully", () => {
      const claim = "索引加速查询";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(prompt.length > 0, "prompt should not be empty");
    });

    it("removes '要点 N：' prefix", () => {
      const claim =
        "要点 1：缓存空值防御穿透时，空值的 TTL 必须短于真实数据的创建周期";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.startsWith("要点"),
        "prompt should not contain '要点' prefix",
      );
    });

    it("does not reveal the full claim conclusion for complex claims", () => {
      const claim =
        "人类认知依赖两套并行机制：低功耗的直觉通道持续产生即时判断，高功耗的逻辑通道仅在直觉受阻时才被唤醒，这种非对称的资源分配是认知偏差的结构性根源";
      const { prompt } = buildValidationPrompt(claim, 0);
      assert.ok(
        !prompt.includes("认知偏差的结构性根源"),
        "prompt must not reveal the claim's conclusion",
      );
      assert.ok(prompt.length < claim.length, "prompt should be shorter");
    });

    it("provides variety across different key points", () => {
      const claims = [
        "当缓存值来源复杂时，应淘汰缓存而非更新",
        "通过节点分裂维持平衡",
        "B+ 树的叶子节点通过链表连接",
      ];
      const types = claims.map((c, i) => buildValidationPrompt(c, i).type);
      // Types should vary (not all the same)
      const uniqueTypes = new Set(types);
      assert.ok(uniqueTypes.size >= 2, "should have at least 2 different types");
    });
  });

  describe("new features - short context handling", () => {
    it("adds '这一知识点' helper for short topic contexts", () => {
      const claim =
        "锚定效应揭示了直觉通道对任意先验信息的不可抑制性：这是一个认知偏差";
      const { prompt } = buildValidationPrompt(claim, 0);
      // "锚定效应" is short (4 chars), should include "这一知识点"
      assert.ok(
        prompt.includes("这一知识点"),
        "prompt should include '这一知识点' for short contexts",
      );
    });

    it("adds '这一知识点' helper for short general contexts", () => {
      const claim = "认知偏差难以自纠，是因为监督通道存在惰性";
      const { prompt } = buildValidationPrompt(claim, 0);
      // "认知偏差" is short (4 chars), should include "这一知识点"
      assert.ok(
        prompt.includes("这一知识点"),
        "prompt should include '这一知识点' for short contexts",
      );
    });

    it("does not add helper for long contexts", () => {
      const claim =
        "将索引数据与路由数据分离存储——路由节点仅负责导航、数据全部聚集在叶子层——能显著提升树的最大扇出";
      const { prompt } = buildValidationPrompt(claim, 0);
      // "将索引数据与路由数据分离存储" is long, should not include "这一知识点"
      assert.ok(
        !prompt.includes("这一知识点"),
        "prompt should not include '这一知识点' for long contexts",
      );
    });
  });
});