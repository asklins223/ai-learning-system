export type CompanionPresence = "quiet" | "moderate" | "active";

export interface CompanionAccountState {
  revision: number;
  epoch: number;
  globalEnabled: boolean;
  presence?: { presence: "online" | "dnd" | "offline"; updatedAt?: string };
  animationOff?: boolean;
  voiceOff?: boolean;
}

export interface CompanionOverview {
  account: CompanionAccountState;
  onboardingStates: Array<{
    onboardingVersion: string;
    revision: number;
    offerStatus: "not_offered" | "offered" | "consumed";
    offerDisposition?: "completed" | "skipped";
  }>;
}

export interface CompanionOnboardingTransitionResponse {
  won?: boolean;
  state: CompanionOverview["onboardingStates"][number];
}

export type LearningSessionOrigin = "card" | "review" | "star_map" | "now";
export type LearningSessionIntent = "stabilize" | "clarify" | "transfer" | "explore";
export type LearningEpisodeProcessingPhase =
  | "preparing"
  | "scene_ready"
  | "awaiting_response"
  | "assessment_pending"
  | "assessment_complete"
  | "commit_pending"
  | "committed"
  | "cancelled"
  | "stale";

export interface LearningSessionEpisode {
  episodeId: string;
  sessionId: string;
  keyPointId: string;
  status: "draft" | "active" | "completed" | "stale" | "cancelled";
  processingPhase: LearningEpisodeProcessingPhase;
  phase: string;
  formalEligibilityKind: string;
  formalPlanKind: string;
  episodeEpoch: number;
  planHash: string;
  budgetEnvelopeRef: string;
  budgetEnvelopeHash: string;
  contentExposureKey: string;
  /** 任务 14 接线：服务端 PREPARE 下发的 journeyPlan（模态 + scenePlan + trustCeiling） */
  journeyPlan: {
    version: "journey-plan-v1";
    mode: "voice" | "silent" | "text" | "transfer" | "practice";
    scenePlan: string[];
    /** silent 场景 public 数据（createSession 冻结时确定性生成） */
    scenes?: Array<{
      sceneId: string;
      sceneType: "ordering" | "repair";
      targetKeyPointId: string;
      publicPayload: unknown;
    }>;
    trustCeiling: "mastery_eligible" | "facet_eligible" | "practice" | "record_only";
    journeyHint: string;
    reason: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface LearningSessionPublicView {
  sessionId: string;
  workspaceId: string;
  userId: string;
  status: "active" | "ended" | "cancelled" | "stale";
  origin: LearningSessionOrigin;
  originRef: { type: string; id: string };
  intent: LearningSessionIntent;
  createdAt: string;
  updatedAt: string;
  episodes: LearningSessionEpisode[];
  activeEpisode: LearningSessionEpisode | null;
  returnTarget: { origin: LearningSessionOrigin; page: string; refId?: string };
}

export interface CreateLearningSessionInput {
  origin: LearningSessionOrigin;
  keyPointId: string;
  intent?: LearningSessionIntent;
}

export interface LearningAnswerResult {
  artifact: {
    artifactId: string;
    episodeId: string;
    keyPointId: string;
    probeId: string;
    modality: "text_or_mixed" | "voice";
    contentHash: string;
    status: "locked";
    answerLockedAt: string;
  };
  episodeStatus: "active";
  processingPhase: "assessment_pending";
}

export interface LearningAssessmentResult {
  episodeId: string;
  sessionId: string;
  artifactId: string;
  verdicts: Array<{
    rubricItemId: string;
    verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
    weight: number;
    required: boolean;
  }>;
  reducerVerdict: string;
  trustClass: string;
  decisionHash: string;
  disposition: "not_assessable" | string;
}

export interface LearningTutorDetour {
  detourId: string;
  sessionId: string;
  episodeId: string;
  targetId: string;
  questionId: string;
  status: "active" | "ended";
  endReason: "return_to_origin" | "end_session" | null;
  questionMarkerSaved: boolean;
  turnCount: number;
  maxTurns: 2;
  createdAt: string;
  endedAt: string | null;
}

export interface LearningTutorTurnResult {
  detour: LearningTutorDetour;
  turn: {
    turnCount: number;
    maxTurns: 2;
    source: "current_target";
    text: string;
    evidence: Array<{ evidenceId: string; quote: string }>;
    followUpAvailable: boolean;
    questionAccepted: boolean;
  };
}
