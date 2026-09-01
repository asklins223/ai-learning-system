/**
 * Plan 23 W1-05：concept_label 确定性派生（2026-08-22 修复）。
 *
 * 背景：生成合同此前缺 conceptLabel 字段，learning_objective_revisions_v2
 * .concept_label 恒为 NULL，前端标题回退 publicSummary 造成"标题=摘要"。
 * 生成端修复后（author prompt 输出概念级标题），存量行由
 * concept-label-backfill-cli 用本模块的确定性规则回填——不调用模型、
 * 幂等、可单测。
 *
 * 规则：剥离开头的掌握类动词前缀 → 取第一个分句 → 清理尾部标点；
 * 过短时回退到剥离后命题的前 24 字。结果只作展示标题，不参与判分。
 *
 * 2026-08-24（AI 设计审查 §4.4 修复）：本文件自 apps/api/src/modules/card-generation-v2/
 * 下沉至 packages/shared（纯逻辑、无 DB/provider 依赖）。worker 与 api 作为平级
 * 消费者经 @ailearn/shared/card-generation-v2-pipeline 子路径引用，消除 worker
 * 内 ../../../../apps/api 反向路径依赖；apps/api 原路径保留兼容 re-export。
 */

/** 剥离命题开头的学习动词前缀（可带冒号/顿号）。 */
const LEADING_VERB_PREFIX =
  /^(?:理解|掌握|说明|解释|描述|阐述|记住|知道|了解|熟悉|分析|判断|计算|推导|列举|区分|复述|概括|总结)+\s*[：:、，,]?\s*/;

/** 首个分句的切分标点。 */
const CLAUSE_DELIMITERS = /[，,。．；;：:！!？?\uFF08(\uFF09)、\n]/;

export function deriveConceptLabelFromStatement(statement: string): string {
  const normalized = statement.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  // 剥离动词前缀后取第一个分句。
  let work = normalized.replace(LEADING_VERB_PREFIX, "");
  const cut = work.search(CLAUSE_DELIMITERS);
  let label = (cut >= 0 ? work.slice(0, cut) : work).trim();

  // 过短（如整句只有一个短词被切空）→ 回退到剥离后的前 24 字。
  if (label.length < 4) {
    label = work.trim().slice(0, 24).trim();
  }

  // 清理尾部残留标点并限长（列上限 200，这里保守 60）。
  label = label.replace(/[，,。．；;：:！!？?、]+$/g, "").trim();
  return label.slice(0, 60);
}

/** 回填候选：statement 优先；statement 派生失败时用 publicSummary 兜底。 */
export function deriveConceptLabel(input: {
  objectiveStatement: string;
  publicSummary?: string | null;
}): string {
  const fromStatement = deriveConceptLabelFromStatement(input.objectiveStatement);
  if (fromStatement.length >= 4) return fromStatement;
  return deriveConceptLabelFromStatement(input.publicSummary ?? "");
}
