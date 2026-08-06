/**
 * Repairer 角色（计划 §16.1）
 *
 * 此文件是计划 §16.1 要求的 `roles/repairer.ts` 文件。
 * Repairer 逻辑实现位于 `agent/repair.ts`，通过此文件统一导出。
 *
 * 计划 §4.7: 整 run 最多创建一个 Repair task，只能根据 Critic hard issues 提交 typed patch。
 */

export {
  executeRepairTurn,
  validateRepairRequest,
  type RepairConfig,
  type RepairTurnOutcome,
} from "../repair.ts";
