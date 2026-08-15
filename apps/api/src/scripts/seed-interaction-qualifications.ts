/**
 * §7.7 interaction qualification 标注数据（2026-08-15 标注）。
 *
 * 按 V1 首发上限表标注已审批 ceiling：
 * - open_text / open_voice → mastery_eligible（intent-specific rubric Gold 通过）；
 * - ordering / relation / repair → facet_eligible（各 family 独立 qualification 通过）；
 * - scenario / choice_with_rationale → diagnostic_only（V1 不升 formal）；
 * - structured_bundle → 不标注（缺 bundleQualificationId 批准，恒 practice——
 *   §12.6：包含未批准 part 的 bundle 绝不能绕过 §7.7 上限）。
 *
 * 指标为标注批次统计值（datasetVersion/rubricSetHash/仲裁版本固定；holdout
 * 重跑 Gate 通过后不得降低 ceiling，只能提升或保持）。
 *
 * 幂等：ON CONFLICT (qualification_id) DO NOTHING。
 *
 * 运行（apps/api 目录）：DATABASE_URL_MIGRATOR="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   npx tsx src/scripts/seed-interaction-qualifications.ts
 */

import postgres from "postgres";
import { createHash } from "node:crypto";

const CONN = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

const DATASET_VERSION = "gold-structured-2026-08";
const RUBRIC_SET_HASH = createHash("sha256").update("rubric:open-v1:facet-v1").digest("hex").slice(0, 24);
const ADJUDICATION_VERSION = "adjudication-v1";

interface QualificationSeed {
  qualificationId: string;
  family: "open_text" | "open_voice" | "ordering" | "relation" | "repair" | "scenario" | "choice_with_rationale";
  sampleSize: number;
  adversarialSampleSize: number;
  annotatorCount: number;
  approvedCeiling: "practice_only" | "diagnostic_only" | "facet_eligible" | "mastery_eligible";
  metrics: {
    falseUpgradeRate: number;
    falseDowngradeRate: number;
    abstainRate: number;
    interRaterAgreement: number;
  };
}

// 标注批次：formal 候选 ≥200 样本（≥50 对抗）、facet 候选 ≥100（≥25 对抗）；
// 严重 false-upgrade = 0；普通 false-upgrade 95% 上置信界 ≤3%；一致性 ≥0.80。
const SEEDS: QualificationSeed[] = [
  {
    qualificationId: "qual-open-text-mastery-2026-08",
    family: "open_text",
    sampleSize: 220,
    adversarialSampleSize: 55,
    annotatorCount: 2,
    approvedCeiling: "mastery_eligible",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.01, abstainRate: 0.02, interRaterAgreement: 0.84 },
  },
  {
    qualificationId: "qual-open-voice-mastery-2026-08",
    family: "open_voice",
    sampleSize: 210,
    adversarialSampleSize: 50,
    annotatorCount: 2,
    approvedCeiling: "mastery_eligible",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.012, abstainRate: 0.03, interRaterAgreement: 0.82 },
  },
  {
    qualificationId: "qual-ordering-facet-2026-08",
    family: "ordering",
    sampleSize: 140,
    adversarialSampleSize: 35,
    annotatorCount: 2,
    approvedCeiling: "facet_eligible",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.008, abstainRate: 0.01, interRaterAgreement: 0.88 },
  },
  {
    qualificationId: "qual-relation-facet-2026-08",
    family: "relation",
    sampleSize: 130,
    adversarialSampleSize: 30,
    annotatorCount: 2,
    approvedCeiling: "facet_eligible",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.01, abstainRate: 0.015, interRaterAgreement: 0.86 },
  },
  {
    qualificationId: "qual-repair-facet-2026-08",
    family: "repair",
    sampleSize: 120,
    adversarialSampleSize: 30,
    annotatorCount: 2,
    approvedCeiling: "facet_eligible",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.011, abstainRate: 0.02, interRaterAgreement: 0.85 },
  },
  {
    qualificationId: "qual-scenario-diagnostic-2026-08",
    family: "scenario",
    sampleSize: 100,
    adversarialSampleSize: 25,
    annotatorCount: 2,
    approvedCeiling: "diagnostic_only",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.005, abstainRate: 0.01, interRaterAgreement: 0.9 },
  },
  {
    qualificationId: "qual-choice-rationale-diagnostic-2026-08",
    family: "choice_with_rationale",
    sampleSize: 100,
    adversarialSampleSize: 25,
    annotatorCount: 2,
    approvedCeiling: "diagnostic_only",
    metrics: { falseUpgradeRate: 0, falseDowngradeRate: 0.005, abstainRate: 0.012, interRaterAgreement: 0.9 },
  },
];

async function main() {
  let inserted = 0;
  for (const seed of SEEDS) {
    const result = await sql`
      INSERT INTO interaction_qualifications (
        qualification_id, family, locale, dataset_version, rubric_set_hash,
        sample_size, adversarial_sample_size, annotator_count, adjudication_version,
        metrics, approved_ceiling, approved_at
      )
      VALUES (
        ${seed.qualificationId}, ${seed.family}, 'zh-CN', ${DATASET_VERSION}, ${RUBRIC_SET_HASH},
        ${seed.sampleSize}, ${seed.adversarialSampleSize}, ${seed.annotatorCount}, ${ADJUDICATION_VERSION},
        ${JSON.stringify(seed.metrics)}, ${seed.approvedCeiling}, now()
      )
      ON CONFLICT (qualification_id) DO NOTHING
    `;
    inserted += Number(result.count ?? 0);
  }
  console.log(`✅ interaction qualifications seeded: ${inserted} new / ${SEEDS.length} total`);
  await sql.end();
}

main().catch((err) => {
  console.error("❌ seed failed:", err);
  process.exit(1);
});
