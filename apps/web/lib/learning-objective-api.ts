/**
 * Plan 23 FE-06：Objective Surface API client（不复用 legacy CardListItem 类型）。
 *
 * 只消费 V3 合同（LearningObjectiveSurfaceV3 / ObjectiveListPageV3 /
 * LearningDashboardV2 / 历史 / route resolution）；服务端 schema 拒绝任何
 * private payload（泄漏 gate 的最后一层在 zod）。
 */
import type {
  LearningObjectiveSurfaceV3,
  ObjectiveListPageV3,
  LearningDashboardV2,
  UnderstandingTopologySnapshotV3,
} from "@ailearn/shared";
import { request } from "./api.ts";

export interface ObjectiveHistoryPage {
  items: Array<{
    objectiveRevisionId: string;
    revision: number;
    revisionClass: string;
    conceptLabel: string | null;
    publicSummary: string;
    knowledgeForm: string;
    supersedesObjectiveRevisionId: string | null;
    publishedAt: string;
  }>;
  total: number;
  nextCursor: number | null;
}

export interface LegacyRouteResolution {
  legacyKind: "card" | "key_point";
  legacyId: string;
  status: "mapped" | "gone" | "ambiguous" | "forbidden";
  objectiveId: string | null;
  cardId: string | null;
  note: string | null;
}

export const learningObjectiveApi = {
  listObjectives: (params?: {
    lifecycle?: "active" | "archived" | "superseded";
    cursor?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.lifecycle) qs.set("lifecycle", params.lifecycle);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? "?" + qs.toString() : "";
    return request<ObjectiveListPageV3>("/v2/learning-objectives" + suffix);
  },

  getObjective: (objectiveId: string) =>
    request<LearningObjectiveSurfaceV3>(
      "/v2/learning-objectives/" + encodeURIComponent(objectiveId),
    ),

  getObjectiveHistory: (objectiveId: string, params?: { limit?: number; cursor?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.cursor !== undefined) qs.set("cursor", String(params.cursor));
    const suffix = qs.toString() ? "?" + qs.toString() : "";
    return request<ObjectiveHistoryPage>(
      "/v2/learning-objectives/" + encodeURIComponent(objectiveId) + "/history" + suffix,
    );
  },

  getDashboard: () => request<LearningDashboardV2>("/v2/learning-dashboard"),

  resolveLegacyRoute: (legacyKind: "card" | "key_point", legacyId: string) => {
    const qs = new URLSearchParams({ legacyKind, legacyId });
    return request<LegacyRouteResolution>("/v2/route-resolution?" + qs.toString());
  },

  getTopology: () => request<UnderstandingTopologySnapshotV3>("/v3/understanding/topology"),
};
