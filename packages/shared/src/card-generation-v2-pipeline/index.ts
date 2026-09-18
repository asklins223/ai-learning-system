/**
 * Card Generation V2 pipeline 纯逻辑层（方案 20 C2/C3/R4）。
 *
 * 2026-08-24（AI 设计审查 §4.4 修复）：planner / author / critic /
 * deterministic-gates / concept-label 自 apps/api 下沉至此——五个模块均为
 * 纯逻辑（不触 DB/provider），apps/api 与 workers/ai-worker 作为平级消费者
 * 引用本子路径，消除 worker 内 `../../../../apps/api/src/...` 反向路径依赖。
 *
 * 边界：
 * - 模型调用一律经调用方注入的 provider 接口，本目录不做任何网络/DB I/O；
 * - 哈希计算走 @ailearn/shared/card-generation-v2-hashing；
 * - 合同类型走 @ailearn/shared/card-generation-v2-contracts 与
 *   card-quality-v2-contracts。
 */

export * from "./planner-service.ts";
export * from "./author-service.ts";
export * from "./critic-service.ts";
export * from "./deterministic-gates.ts";
export * from "./concept-label.ts";
// 2026-09-17（性能改造）：阶段内有界并发（author/grounding 由逐候选串行改为并发）。
export * from "./concurrency.ts";
// 2026-08-24（§4.4 第二批）：evidence seal 与 binding plan 的纯逻辑层。
// DB 写入（snapshots/eligibility/binding plan 落库）在 apps/api 的 IO 壳。
export * from "./evidence-seal-core.ts";
export * from "./binding-plan-core.ts";
