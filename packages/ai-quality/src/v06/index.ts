/**
 * v0.6 AI Quality 黄金集导出 (计划 §4.2)
 *
 * 导出三套黄金集数据、评分器和验证函数。
 */

// 类型
export type {
  GoldDatasetVersion,
  QuestionRubricGoldSample,
  ExpectedRubricItem,
  EvaluationGoldSample,
  TrueItemVerdict,
  CardRepairGoldSample,
  CardDraftWithDefects,
  SourceBlock,
  CardRepairTrigger,
  QuestionRubricPrediction,
  EvaluationPrediction,
  CardRepairMetricSnapshot,
  CardRepairPrediction,
  V06ScorerPredictions,
  QuestionRubricScorerMetrics,
  EvaluationScorerMetrics,
  CardRepairScorerMetrics,
} from "./types.ts";

// 阈值
export {
  QUESTION_RUBRIC_THRESHOLDS,
  EVALUATION_THRESHOLDS,
  CARD_REPAIR_THRESHOLDS,
} from "./types.ts";

// Question/Rubric Gold v1
export {
  QUESTION_RUBRIC_GOLD,
  QUESTION_RUBRIC_GOLD_VERSION,
  QUESTION_RUBRIC_GOLD_MINIMUM_SIZE,
  getQuestionRubricGoldStats,
} from "./question-rubric-gold.ts";

// Evaluation Gold v1
export {
  EVALUATION_GOLD,
  EVALUATION_GOLD_VERSION,
  EVALUATION_GOLD_MINIMUM_SIZE,
  getEvaluationGoldStats,
} from "./evaluation-gold.ts";

// Card Repair Gold v1
export {
  CARD_REPAIR_GOLD,
  CARD_REPAIR_GOLD_VERSION,
  CARD_REPAIR_GOLD_MINIMUM_SIZE,
  getCardRepairGoldStats,
} from "./card-repair-gold.ts";

// 评分器
export {
  V06_SCORER_VERSION,
  scoreQuestionRubric,
  scoreEvaluation,
  scoreCardRepair,
  generateV06ScorerReport,
} from "./scorer.ts";
