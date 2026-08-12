/**
 * learning-sessions 模块出口（阶段 02，W1；阶段 03，W2）。
 *
 * 目前包括：
 * - Generation → Learning handoff adapter（任务 02-6）；
 * - existing-domain-multimodal-adapter-v1 旧域兼容 adapter（任务 02-7）；
 * - learning_unit_exposure aggregate/guard（任务 02-8）；
 * - canonical 事件、投影与重放（任务 02-9）；
 * - PREPARE 与 Session 生命周期（任务 03-2）：session-service / session-routes。
 */

export * from "./handoff-adapter.ts";
export * from "./legacy-adapter.ts";
export * from "./exposure-service.ts";
export * from "./canonical-events.ts";
export * from "./session-service.ts";
export * from "./session-routes.ts";
export * from "./journey-plan.ts";
