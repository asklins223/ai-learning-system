/**
 * §14.2 canonical context revision（Electron broker 与服务端共用）。
 *
 * node:crypto 依赖 → 只经子路径 import（@ailearn/shared/companion-bridge-revision），
 * 不进 index 全量导出（客户端 bundle 会触发 node: 缺失崩溃）。
 * Electron broker 与 API hydration 使用同一公式，保证 revision 两端一致。
 */

import { createHash } from "node:crypto";
import type { MainPageContextInput } from "./companion-bridge-contracts.ts";

export function computeContextRevisionV2(input: MainPageContextInput): string {
  const canonical = JSON.stringify({
    routeRef: input.routeRef,
    pageKind: input.pageKind,
    entityRefs: [...input.entityRefs].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))),
    interactionState: input.interactionState,
    graph: input.graph ?? null,
    capabilityHints: [...input.capabilityHints].sort(),
    sensitivity: input.sensitivity,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
