/**
 * 兼容 re-export（2026-08-24 AI 设计审查 §4.4 修复）。
 *
 * 实现已下沉至 packages/shared/src/card-generation-v2-pipeline/deterministic-gates.ts
 * （纯逻辑模块与 worker 平级消费）。新代码请直接引用
 * `@ailearn/shared/card-generation-v2-pipeline`；本路径仅为既有 api 内部
 * 导入保留。
 */
export * from "@ailearn/shared/card-generation-v2-pipeline";
