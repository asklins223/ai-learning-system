import { z } from "zod";

/**
 * 能力 id 表——**只保留 id 词汇本身**。
 *
 * 2026-09-22（doc 34 L34）：这里原本是一套**并行的第二能力系统**，35 个导出里 32 个对外
 * 零消费者（bundle 分组、依赖边、原子包含、状态/配置/快照、`createCapabilityConfig`、
 * `CapabilityApiViewV1`）。真正门控路由的是 15 支 `COMPANION_*` / `CARD_*` 环境变量旗标
 * （见 `docs/feature-flag-inventory.md`），两边互不映射，而
 * `docs/plans/learning-companion/01-7-feature-flags-capability-bundles.md` 把这套称作
 * 「单一事实来源」——声明与执行分了家。按 `AGENTS.md` 删掉那 32 个。
 *
 * 留下的 id **不是死的**：`desktop-ipc-contracts.ts:1013` 用 `[...CAPABILITY_IDS,
 * ...featureNameExtraValues]` 拼出 IPC 的功能名表（`featureNameSchema`/`FeatureName`），
 * 少一个 id 就会改变客户端能声明的功能名集合。**顺序保持原样**（must → should →
 * internal 三段拼接），分组语义已删但分组曾经存在，别随手重排。
 *
 * 要恢复成真正的能力合同是一次新设计：先回答它取代还是统领 env 旗标，以及
 * `CapabilityApiViewV1` 那个「authenticated Web 读取」消费面（`PRODUCT.md:10` 已取消
 * 浏览器端产品）还要不要——别再长出第二套事实。
 */
export const CAPABILITY_IDS = [
  // 原 must-bundle 段
  "trusted_multimodal_core",
  "global_companion_shell",
  "companion_onboarding_v1",
  "learning_run_companion",
  "multimodal_voice",
  "structured_proof_v1",
  "journey_routes",
  "understanding_universe_v2",
  "current_target_tutor",
  // 原 should-bundle 段
  "learning_question_markers",
  "semantic_relationships",
  "tutor_workspace_expansion",
  "learning_objective_system_v3",
  // 原 internal-atomic 段
  "scene",
  "critic",
  "commit",
  "map",
  "projection",
  "grounded_answer_critic"
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const capabilityIdSchema = z.enum(CAPABILITY_IDS);
