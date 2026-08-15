/**
 * learning-session 核心合同类型（阶段 03 / W2）
 *
 * 单一来源（01-2 §5 冻结语义）。禁止在各模块内重复定义同型接口；
 * 字段改动必须回 W0（阶段 01）评审。
 *
 * 2026-08-13（文档 16 §12）：TrustClass 已并入 LearningRun V1 统一合同
 * （learning-run-contracts.ts），值域完全一致；本文件 re-export 以保持旧
 * Session/Episode 代码引用不变。CapabilityFacet 等旧语言符号继续保留。
 */

import { TrustClass as TrustClassValues } from "./learning-run-contracts.ts";
import type { TrustClassV1 } from "./learning-run-contracts.ts";

export const TrustClass = TrustClassValues;
export type TrustClass = TrustClassV1;

/** 能力切面（01-2 §7.4）：v1 六个 facet */
export const CapabilityFacet = {
  RECALL: "recall",
  EXPLAIN: "explain",
  APPLY: "apply",
  BOUNDARY: "boundary",
  PROCEDURE: "procedure",
  RELATE: "relate",
} as const;
export type CapabilityFacet = (typeof CapabilityFacet)[keyof typeof CapabilityFacet];

/** RubricTarget（01-2 §7.1 冻结）。server-only expected target 绝不返回客户端。 */
export interface RubricTarget {
  id: string;
  criterion: string;
  /** server-only expected target 引用（绝不返回客户端） */
  expectedTargetRef: string;
  expectedTargetHash: string;
  weight: 1 | 2 | 3;
  required: boolean;
  capabilityFacet: CapabilityFacet;
  targetKeyPointId: string;
  evidenceRefIds: string[];
  semanticSupportReportId: string;
  semanticSupportReportHash: string;
}

/**
 * FrozenProbeRef（01-2 §5）：冻结的 trusted probe 引用。公测 v1 同一 formal Episode
 * 首次回答前冻结全部 trusted probes 和分支；只存 scene 三对象独立引用与 hash，
 * 不存 solution 原文。
 */
export interface FrozenProbeRef {
  probeId: string;
  publicSceneContractId: string;
  publicPayloadHash: string;
  privateSolutionId: string;
  privateSolutionHash: string;
  sceneSafetyReportId: string;
  sceneSafetyReportHash: string;
  templateTrustCeiling: TrustClass;
  disclosureProfileHash: string;
}
