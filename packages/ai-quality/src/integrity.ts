/**
 * AIQ-01 数据集与标签完整性校验
 *
 * 对应 ADR-0005 第 4 条：
 * "CI 必须校验每个 key point 标签覆盖完整，无标签时不得把指标显示为通过"。
 *
 * 校验项：
 * 1. 数据集样本唯一性：file key 不能重复
 * 2. 数据集样本非空：每个样本必须有标题和至少一个块
 * 3. 标签文件覆盖：每个数据集样本必须有对应的标签文件
 * 4. 标签 ordinal 唯一性：同一标签文件内 ordinal 不能重复
 * 5. 标签 expectedBlockOrdinal 范围：不能超出对应样本的块数量
 * 6. 标签非空：每个标签文件至少有一个 keyPoint
 *
 * 这些校验是 PR 硬门禁：任一校验失败，PR 被阻断。
 */

import { GOLDEN_DATASET, getDatasetSample } from "./dataset.ts";
import { GOLDEN_LABELS } from "./labels.ts";

/**
 * 完整性校验结果。
 */
export interface IntegrityResult {
  /** 校验是否通过 */
  valid: boolean;
  /** 校验错误列表 */
  errors: string[];
  /** 数据集样本数 */
  datasetSampleCount: number;
  /** 标签文件数 */
  labelFileCount: number;
  /** 总 key point 标注数 */
  totalLabels: number;
}

/**
 * 校验数据集与标签的完整性。
 *
 * 这是 PR 门禁的核心校验函数。返回 valid=false 时，
 * PR Mock runner 必须阻断并报告所有错误。
 */
export function validateIntegrity(): IntegrityResult {
  const errors: string[] = [];

  // 1. 校验数据集样本唯一性
  const seenFiles = new Set<string>();
  for (const sample of GOLDEN_DATASET) {
    if (seenFiles.has(sample.file)) {
      errors.push(`数据集样本 file key 重复：${sample.file}`);
    }
    seenFiles.add(sample.file);

    // 2. 校验数据集样本非空
    if (!sample.title || sample.title.trim().length === 0) {
      errors.push(`数据集样本 ${sample.file} 标题为空`);
    }
    if (!sample.blocks || sample.blocks.length === 0) {
      errors.push(`数据集样本 ${sample.file} 内容块为空`);
    }
  }

  // 3. 校验标签文件覆盖：每个数据集样本必须有对应标签
  const labelMap = new Map<string, typeof GOLDEN_LABELS[number]>();
  for (const label of GOLDEN_LABELS) {
    labelMap.set(label.noteFile, label);
  }

  for (const sample of GOLDEN_DATASET) {
    if (!labelMap.has(sample.file)) {
      errors.push(`数据集样本 ${sample.file} 缺少黄金标签文件`);
    }
  }

  // 校验标签文件不引用不存在的样本
  for (const label of GOLDEN_LABELS) {
    if (!getDatasetSample(label.noteFile)) {
      errors.push(`标签文件 ${label.noteFile} 引用了不存在的数据集样本`);
    }
  }

  // 4. 校验标签 ordinal 唯一性和 expectedBlockOrdinal 范围
  let totalLabels = 0;
  for (const label of GOLDEN_LABELS) {
    const sample = getDatasetSample(label.noteFile);

    // 6. 校验标签非空
    if (label.keyPoints.length === 0) {
      errors.push(`标签文件 ${label.noteFile} 的 keyPoints 为空`);
    }

    const seenOrdinals = new Set<number>();
    for (const kp of label.keyPoints) {
      totalLabels++;

      if (seenOrdinals.has(kp.ordinal)) {
        errors.push(`标签文件 ${label.noteFile} 中 ordinal ${kp.ordinal} 重复`);
      }
      seenOrdinals.add(kp.ordinal);

      // 5. 校验 expectedBlockOrdinal 范围
      if (sample && kp.expectedBlockOrdinal !== null) {
        if (kp.expectedBlockOrdinal < 0 || kp.expectedBlockOrdinal >= sample.blocks.length) {
          errors.push(
            `标签文件 ${label.noteFile} 的 ordinal ${kp.ordinal} 的 expectedBlockOrdinal ${kp.expectedBlockOrdinal} 超出样本块范围（0-${sample.blocks.length - 1}）`,
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    datasetSampleCount: GOLDEN_DATASET.length,
    labelFileCount: GOLDEN_LABELS.length,
    totalLabels,
  };
}

/**
 * 校验模型输出是否覆盖了标签中的所有 ordinal。
 *
 * 这对应 ADR-0005 第 4 条：
 * "无标签时不得把指标显示为通过"。
 *
 * 如果模型输出的 key point 数量与标签不匹配，
 * metricsVerified 必须为 false。
 */
export function validateOutputCoverage(
  _noteFile: string,
  modelKeyPoints: Array<{ ordinal: number }>,
  labels: Array<{ ordinal: number }>,
): { covered: boolean; missingOrdinals: number[]; extraOrdinals: number[] } {
  const labelOrdinals = new Set(labels.map((l) => l.ordinal));
  const modelOrdinals = new Set(modelKeyPoints.map((kp) => kp.ordinal));

  const missingOrdinals = [...labelOrdinals].filter((o) => !modelOrdinals.has(o));
  const extraOrdinals = [...modelOrdinals].filter((o) => !labelOrdinals.has(o));

  return {
    covered: missingOrdinals.length === 0 && extraOrdinals.length === 0,
    missingOrdinals,
    extraOrdinals,
  };
}
