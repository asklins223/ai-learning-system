/**
 * Main ↔ Pet Bridge 服务端 context hydration（文档 16 §14.2）。
 *
 * renderer 提交的 MainPageContextInputV2 是不可信提示：本模块逐 EntityRef
 * 校验（存在性 + workspace/user 归属，全部 RLS 内查询），通过后计算 canonical
 * revision 并签发完整 AssistantContextSnapshotV2（account/workspace/user 由
 * 认证 session 提供，renderer 不可自报）。任一实体校验失败 → 整体拒绝
 * （fail closed：不签发"看起来差不多"的 context）。
 *
 * 纯函数（computeContextRevision / hydrateContext）独立可测；DB 归属校验由
 * service 层在 withWorkspaceTransaction 内执行。
 */

import type {
  AssistantContextSnapshotV2,
  EntityRefV2,
  MainPageContextInputV2,
} from "@ailearn/shared";
import { computeContextRevisionV2 } from "@ailearn/shared/companion-bridge-revision";

export { computeContextRevisionV2 };

export const CONTEXT_LEASE_SECONDS = 30;
export const CONTEXT_RENEW_WINDOW_SECONDS = 10;

export interface HydratedContextInput {
  contextId: string;
  accountSessionId: string;
  deviceSessionId: string;
  workspaceId: string;
  userId: string;
  pageInstanceId: string;
  input: MainPageContextInputV2;
  issuedAt: Date;
  expiresAt: Date;
}

/** canonical revision：route/entity/interaction/graph/hints 的确定性摘要。 */
export function computeContextRevision(input: MainPageContextInputV2): string {
  return computeContextRevisionV2(input as never);
}

/** 组装完整快照（安全字段由服务端/broker 提供，不信任 renderer）。 */
export function buildContextSnapshot(input: HydratedContextInput): AssistantContextSnapshotV2 {
  return {
    version: 2,
    contextId: input.contextId,
    accountSessionId: input.accountSessionId,
    deviceSessionId: input.deviceSessionId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    pageInstanceId: input.pageInstanceId,
    revision: computeContextRevision(input.input),
    routeRef: input.input.routeRef,
    pageKind: input.input.pageKind,
    entityRefs: input.input.entityRefs,
    interactionState: input.input.interactionState,
    graph: input.input.graph,
    capabilityHints: input.input.capabilityHints,
    sensitivity: input.input.sensitivity,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

/** EntityRef 归一到可查询形式（归属校验输入）。 */
export function entityLookupKey(ref: EntityRefV2): { table: string; id: string } | null {
  switch (ref.kind) {
    case "source": return { table: "sources", id: ref.sourceId };
    case "note": return { table: "notes", id: ref.noteId };
    // V1 卡/卡组/要点表已随旧栈退役：card→V2 卡表；key_point→objective（alias）；
    // card_set 无 V2 等价物 → 不支持（fail soft，不查询已删表）。
    case "card_set": return null;
    case "card": return { table: "learning_cards_v2", id: ref.cardId };
    case "key_point": return { table: "learning_objectives_v2", id: ref.keyPointId };
    case "evidence": return { table: "evidences", id: ref.evidenceId };
    case "review_schedule": return { table: "review_schedules", id: ref.scheduleId };
    case "learning_run": return { table: "learning_runs", id: ref.runId };
    case "learning_task": return { table: "learning_tasks", id: ref.taskId };
    case "companion_journey": return { table: "companion_journeys", id: ref.journeyId };
    case "assistant_session": return { table: "companion_conversations", id: ref.assistantSessionId };
    case "route_plan": return { table: "understanding_route_plans", id: ref.routePlanId };
    case "change_set": return { table: "understanding_change_sets", id: ref.changeSetId };
  }
}

export class ContextHydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextHydrationError";
  }
}
