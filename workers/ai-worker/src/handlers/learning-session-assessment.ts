/**
 * Direct Learning Session assessment application service for the worker.
 *
 * This deliberately does not call the API over HTTP and never receives a
 * browser cookie. The worker claims only identifier-only commands, restores
 * the row's workspace/user RLS context, and performs the diagnostic report +
 * processing-phase transition in one transaction.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { LearningEpisodeStatus, LearningProcessingPhase } from "@ailearn/shared";
import { createProvider } from "../lib/ai-provider.ts";
import { evaluateRubricViaChat } from "../lib/business-ai-ops.ts";
import {
  AIConsentRequiredError,
  enforcePrivacyGovernanceWithPolicy,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { sanitizeOperationalError } from "@ailearn/shared";
import {
  assessRubricSet,
  type ArtifactModality,
  type FrozenRubricTarget,
  type LockedArtifactView,
  type ProposedAssessment,
  type RubricAssessment,
} from "../learning-agent/roles/assessment-critic.ts";

export interface LearningSessionAssessmentInput {
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  artifactId: string;
}

export interface AssessmentOutboxRow extends LearningSessionAssessmentInput {
  id: string;
  attempts: number;
  leaseOwner: string;
}

export class LearningSessionAssessmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LearningSessionAssessmentError";
    this.code = code;
  }
}

type SqlTransaction = Pick<WorkerTransaction, "execute">;

export type AssessmentContext = {
  workspaceId: string;
  userId: string;
  artifact: LockedArtifactView;
  artifactPayload: Record<string, unknown>;
  artifactEpisodeTargetFingerprint: string;
  episode: {
    id: string;
    sessionId: string;
    status: string;
    processingPhase: string;
    keyPointId: string;
    rubricTargets: unknown[];
    modelId: string;
    episodeTargetFingerprint: string;
  };
  question: string;
};

type AssessmentBundle = {
  assessments: RubricAssessment[];
  reportHash: string;
  decisionHash: string;
  criticVersion: string;
  assessmentSource: "deterministic" | "critic";
};

class LearningSessionAssessmentRetryableError extends LearningSessionAssessmentError {
  constructor(message: string) {
    super("ASSESSMENT_CRITIC_RETRYABLE", message);
  }
}

// Keep these tiny hash primitives local to the worker bundle. They intentionally
// mirror packages/shared/src/learning-assessment.ts so a stale file: dependency
// cannot make a production worker silently derive a different idempotency hash.
function sha256Hex(value: string): string {
  const hash = createHash("sha256");
  const update = hash.update.bind(hash);
  update(value, "utf8");
  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().flatMap((key) => {
    const item = object[key];
    return item === undefined ? [] : [`${JSON.stringify(key)}:${stableStringify(item)}`];
  }).join(",")}}`;
}

function computeAssessmentInputHash(value: string): string {
  return sha256Hex(value);
}

function computeFailClosedAssessmentDecisionHash(input: {
  episodeId: string;
  artifactId: string;
  reducerResult: string;
  canonicalCommitEnabled: boolean;
}): string {
  const decision = {
    episodeId: input.episodeId,
    effectiveClass: "not_assessable",
    sourceArtifactIds: [input.artifactId].sort((left, right) => left.localeCompare(right)),
    frozenProbeSetHash: sha256Hex("assessment-critic-unavailable"),
    requiredRubricCoverageHash: sha256Hex("assessment-coverage-unavailable"),
    assistanceSnapshotHash: sha256Hex("assessment-assistance-unavailable"),
    reasonCodes: [
      "assessment_critic_unavailable",
      `reducer:${input.reducerResult}`,
      ...(input.canonicalCommitEnabled ? [] : ["canonical_commit_disabled"]),
    ].sort((left, right) => left.localeCompare(right)),
  };
  return sha256Hex(`episode-trust-v1:${stableStringify(decision)}`);
}

function computeAssessmentReportHash(
  episodeId: string,
  artifactId: string,
  decisionHash: string,
): string {
  return sha256Hex(`${episodeId}:${artifactId}:${decisionHash}`);
}

function isCanonicalCommitEnabled(): boolean {
  return process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED === "true";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string");
  return result.length === value.length ? result : undefined;
}

function scoringModeForTarget(
  target: Record<string, unknown>,
  artifactModality: string,
): FrozenRubricTarget["scoringMode"] {
  const explicit = stringValue(target.scoringMode);
  if (
    explicit === "ordering" || explicit === "graph" || explicit === "typed_repair"
    || explicit === "open_semantic" || explicit === "voice" || explicit === "complex_reasoning"
  ) {
    return explicit;
  }
  if (Array.isArray(target.expectedOrderIds)) return "ordering";
  if (Array.isArray(target.expectedEdgeSet)) return "graph";
  if (Array.isArray(target.expectedRepairOps)) return "typed_repair";
  return artifactModality === "voice" ? "voice" : "open_semantic";
}

function freezeRubricTarget(
  rawTarget: unknown,
  index: number,
  artifactModality: string,
): FrozenRubricTarget {
  const target = asRecord(rawTarget);
  const rubricItemId =
    stringValue(target.rubricItemId)
    ?? stringValue(target.id)
    ?? stringValue(target.itemId)
    ?? `rubric-${index}`;
  const evidenceRefIds = stringArray(target.evidenceRefIds) ?? [];
  return {
    rubricItemId,
    keyPointId: stringValue(target.targetKeyPointId) ?? undefined,
    facet: stringValue(target.facet) ?? stringValue(target.capabilityFacet) ?? undefined,
    scoringMode: scoringModeForTarget(target, artifactModality),
    evidenceRefIds,
    expectedOrderIds: stringArray(target.expectedOrderIds),
    expectedEdgeSet: stringArray(target.expectedEdgeSet),
    expectedRepairOps: stringArray(target.expectedRepairOps),
  };
}

function lockedArtifactFromRow(row: Record<string, unknown>): {
  artifact: LockedArtifactView;
  payload: Record<string, unknown>;
} {
  const payload = asRecord(row.payload);
  const modality = String(row.modality ?? "") as ArtifactModality;
  const answer = answerText(payload, modality);
  const artifact: LockedArtifactView = {
    artifactId: String(row.id),
    status: String(row.status ?? "") as LockedArtifactView["status"],
    modality,
    revision: Number(row.revision ?? 0),
    contentHash: String(row.contentHash ?? ""),
    // Text answers are already server-confirmed by answer-submission. Exposing
    // them as the canonical text lets the Critic validate excerpts without
    // adding a second mutable answer field to the artifact schema.
    transcript: answer,
    transcriptHash: stringValue(payload.transcriptHash) ?? undefined,
    segments: Array.isArray(payload.segments) ? payload.segments as LockedArtifactView["segments"] : undefined,
    asrConfidence: typeof payload.asrConfidence === "number" ? payload.asrConfidence : undefined,
    asrProvider: stringValue(payload.asrProvider) ?? undefined,
    asrModel: stringValue(payload.asrModel) ?? undefined,
    orderedIds: stringArray(payload.orderedIds),
    allowlistedItemIds: stringArray(payload.allowlistedItemIds),
    edges: stringArray(payload.edges),
    repairOps: stringArray(payload.repairOps),
    interactionRefs: stringArray(payload.interactionRefs),
    supersedesArtifactId: stringValue(row.supersedesArtifactId) ?? undefined,
    correctionMethod: stringValue(row.correctionMethod) as LockedArtifactView["correctionMethod"],
  };
  return { artifact, payload };
}

export function buildFailClosedCriticAssessments(context: AssessmentContext): RubricAssessment[] {
  const targets = context.episode.rubricTargets.map((raw, index) =>
    freezeRubricTarget(raw, index, context.artifact.modality),
  );
  const proposals: ProposedAssessment[] = targets
    .filter((target) => !["ordering", "graph", "typed_repair"].includes(target.scoringMode))
    .map((target) => ({
      rubricItemId: target.rubricItemId,
      verdict: "not_assessable",
      evidenceRefIds: [],
      confidence: 0,
      rationale: "not_assessable:assessment_critic_unavailable",
      source: "critic",
    }));
  return assessRubricSet({
    artifact: context.artifact,
    frozenRubricTargets: targets,
    preboundEvidenceByItem: Object.fromEntries(
      targets.map((target) => [target.rubricItemId, [...target.evidenceRefIds]]),
    ),
    proposals,
  });
}

function isAssessmentCriticEnabled(): boolean {
  return process.env.LEARNING_SESSION_ASSESSMENT_CRITIC_ENABLED === "true";
}

function isDeterministicTarget(target: FrozenRubricTarget): boolean {
  return target.scoringMode === "ordering"
    || target.scoringMode === "graph"
    || target.scoringMode === "typed_repair";
}

export async function buildCriticAssessments(
  context: AssessmentContext,
  signal?: AbortSignal,
): Promise<{ assessments: RubricAssessment[]; criticVersion: string; source: "deterministic" | "critic" }> {
  const targets = context.episode.rubricTargets.map((raw, index) =>
    freezeRubricTarget(raw, index, context.artifact.modality),
  );
  const semanticTargets = targets.filter((target) => !isDeterministicTarget(target));
  if (semanticTargets.length === 0) {
    return {
      assessments: assessRubricSet({
        artifact: context.artifact,
        frozenRubricTargets: targets,
        preboundEvidenceByItem: Object.fromEntries(
          targets.map((target) => [target.rubricItemId, [...target.evidenceRefIds]]),
        ),
      }),
      criticVersion: "assessment-critic-deterministic-v1",
      source: "deterministic",
    };
  }

  if (!isAssessmentCriticEnabled()) {
    return {
      assessments: buildFailClosedCriticAssessments(context),
      criticVersion: "diagnostic-fail-closed-v1",
      // The independent Critic provider is unavailable. The persisted report
      // is produced by the deterministic fail-closed reducer, so do not label
      // it as a provider-backed Critic result.
      source: "deterministic",
    };
  }

  if (context.question === "" || answerText(context.artifactPayload, context.artifact.modality) === "") {
    throw new LearningSessionAssessmentRetryableError("Critic 输入缺少冻结 question 或回答文本");
  }
  const governance = await resolveAIGovernanceContext(
    context.workspaceId,
    context.userId,
  );
  if (!governance.consentOk) {
    throw new AIConsentRequiredError();
  }
  const providerSelection = resolveProviderForTask(governance, "evaluate_rubric");
  const governanceResult = enforcePrivacyGovernanceWithPolicy(
    governance.policy,
    context.workspaceId,
    ["question", "user_answer", "claim"],
    {
      question: context.question,
      questionType: context.artifact.modality,
      claim: context.question,
      userAnswer: answerText(context.artifactPayload, context.artifact.modality),
    },
    providerSelection.providerName,
  );
  if (!governanceResult.allowed) {
    // 2026-08-12+（15a 根因修复）：policy 拒绝（sendToExternal=false）不可重试、
    // 需用户在设置开启——抛 AIConsentRequiredError（前端引导），而非可重试错误。
    throw new AIConsentRequiredError();
  }
  const safeInput = governanceResult.sanitizedData as {
    question: string;
    questionType: string;
    userAnswer: string;
  };
  const provider = createProvider(providerSelection.providerName, providerSelection.providerConfig);
  const providerResult = await runWithAbortBudget(
    (criticSignal) => evaluateRubricViaChat(provider, {
      question: safeInput.question,
      questionType: safeInput.questionType,
      userAnswer: safeInput.userAnswer,
      rubricItems: semanticTargets.map((target) => ({
        rubricItemId: target.rubricItemId,
        criterion: target.facet ?? "当前能力切面",
        weight: 1,
        required: true,
      })),
    }, criticSignal),
    signal,
    resolveProviderCallTimeout("evaluate_rubric"),
  );
  const proposals: ProposedAssessment[] = providerResult.output.itemResults.map((item) => ({
    rubricItemId: item.rubricItemId,
    verdict: item.verdict,
    evidenceRefIds: [],
    answerExcerpt: item.answerExcerpt,
    confidence: item.confidence,
    rationale: item.rationale,
    source: "critic",
  }));
  return {
    assessments: assessRubricSet({
      artifact: context.artifact,
      frozenRubricTargets: targets,
      preboundEvidenceByItem: Object.fromEntries(
        targets.map((target) => [target.rubricItemId, [...target.evidenceRefIds]]),
      ),
      proposals,
    }),
    criticVersion: `assessment-critic-${provider.id}-${provider.modelId}`.slice(0, 180),
    source: "critic",
  };
}

function computeCriticDecisionHash(input: {
  episodeId: string;
  artifactId: string;
  assessments: RubricAssessment[];
  criticVersion: string;
  canonicalCommitEnabled: boolean;
}): string {
  const decision = {
    episodeId: input.episodeId,
    effectiveClass: "diagnostic_only",
    sourceArtifactIds: [input.artifactId],
    assessmentHash: sha256Hex(stableStringify(input.assessments)),
    criticVersion: input.criticVersion,
    reasonCodes: [
      "assessment_critic_completed",
      ...(input.canonicalCommitEnabled ? ["commit_gate_pending"] : ["canonical_commit_disabled"]),
    ],
  };
  return sha256Hex(`episode-trust-v1:${stableStringify(decision)}`);
}

function computeCriticReportHash(
  episodeId: string,
  artifactId: string,
  decisionHash: string,
  assessments: RubricAssessment[],
): string {
  return sha256Hex(`${episodeId}:${artifactId}:${decisionHash}:${sha256Hex(stableStringify(assessments))}`);
}

function answerText(payload: unknown, modality: string): string {
  const body = asRecord(payload);
  const value = modality === "voice" ? body.confirmedTranscript : body.text;
  return typeof value === "string" ? value.trim() : "";
}

function rubricItemId(target: unknown, index: number): string {
  const body = asRecord(target);
  return typeof body.itemId === "string" ? body.itemId : `rubric-${index}`;
}

export function buildFailClosedAssessment(input: {
  episodeId: string;
  artifactId: string;
  rubricTargets: unknown[];
  canonicalCommitEnabled: boolean;
}) {
  const verdicts = input.rubricTargets.map((target, index) => ({
    rubricItemId: rubricItemId(target, index),
    verdict: "not_assessable" as const,
    weight: 1,
    required: true,
  }));
  const decisionHash = computeFailClosedAssessmentDecisionHash({
    episodeId: input.episodeId,
    artifactId: input.artifactId,
    reducerResult: "not_assessable",
    canonicalCommitEnabled: input.canonicalCommitEnabled,
  });
  return {
    verdicts,
    decisionHash,
    reportHash: computeAssessmentReportHash(input.episodeId, input.artifactId, decisionHash),
    probeHash: computeAssessmentInputHash("assessment-critic-unavailable"),
  };
}

export async function assessLearningSessionWithTransaction(
  input: LearningSessionAssessmentInput,
  transaction: SqlTransaction,
): Promise<"processed" | "already_processed"> {
  const artifactRows = (await transaction.execute(sql`
    SELECT id, session_id AS "sessionId", episode_id AS "episodeId",
           status, modality, payload
    FROM learning_response_artifacts
    WHERE id = ${input.artifactId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const artifact = artifactRows[0];
  if (!artifact) {
    throw new LearningSessionAssessmentError("artifact_not_found", "锁定 artifact 不存在");
  }
  if (String(artifact.sessionId) !== input.sessionId || String(artifact.episodeId) !== input.episodeId) {
    throw new LearningSessionAssessmentError("session_or_episode_mismatch", "artifact 归属不匹配");
  }
  if (String(artifact.status) !== "locked") {
    throw new LearningSessionAssessmentError("artifact_not_locked", "仅锁定 artifact 可评测");
  }
  if (answerText(artifact.payload, String(artifact.modality)) === "") {
    throw new LearningSessionAssessmentError("empty_answer", "锁定 artifact 无回答文本");
  }

  const episodeRows = (await transaction.execute(sql`
    SELECT id, session_id AS "sessionId", status,
           processing_phase AS "processingPhase", rubric_targets AS "rubricTargets"
    FROM learning_episodes
    WHERE id = ${input.episodeId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const episode = episodeRows[0];
  if (!episode || String(episode.sessionId) !== input.sessionId) {
    throw new LearningSessionAssessmentError("episode_not_found", "Episode 不存在或归属不匹配");
  }

  const phase = String(episode.processingPhase ?? LearningProcessingPhase.AWAITING_RESPONSE);
  const rubricTargets = Array.isArray(episode.rubricTargets) ? episode.rubricTargets : [];
  if (rubricTargets.length === 0) {
    throw new LearningSessionAssessmentError("rubric_targets_empty", "Episode 无 rubric targets");
  }
  const assessment = buildFailClosedAssessment({
    episodeId: input.episodeId,
    artifactId: input.artifactId,
    rubricTargets,
    canonicalCommitEnabled: isCanonicalCommitEnabled(),
  });

  if (phase === LearningProcessingPhase.ASSESSMENT_COMPLETE) {
    const existingRows = (await transaction.execute(sql`
      SELECT id
      FROM learning_assessment_reports
      WHERE workspace_id = ${input.workspaceId}
        AND user_id = ${input.userId}
        AND episode_id = ${input.episodeId}
        AND report_hash = ${assessment.reportHash}
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    if (existingRows[0]) return "already_processed";
    throw new LearningSessionAssessmentError(
      "assessment_result_not_found",
      "Episode 已完成评估但报告不可重放",
    );
  }
  if (String(episode.status) !== LearningEpisodeStatus.ACTIVE || phase !== LearningProcessingPhase.ASSESSMENT_PENDING) {
    throw new LearningSessionAssessmentError(
      "episode_not_assessable",
      `Episode 当前阶段 ${phase} 不可评测`,
    );
  }

  const reportRubrics = assessment.verdicts.map((verdict) => ({
    rubricItemId: verdict.rubricItemId,
    verdict: verdict.verdict,
    weight: verdict.weight,
    required: verdict.required,
  }));
  await transaction.execute(sql`
    INSERT INTO learning_assessment_reports (
      session_id, episode_id, workspace_id, user_id,
      critic_version, reducer_version, assessment_source,
      rubric_assessments, report_hash, decision_hash
    ) VALUES (
      ${input.sessionId}, ${input.episodeId}, ${input.workspaceId}, ${input.userId},
      'diagnostic-fail-closed-v1', 'rubric-session-reducer-v2', 'deterministic',
      ${JSON.stringify(reportRubrics)}, ${assessment.reportHash}, ${assessment.decisionHash}
    )
    ON CONFLICT (workspace_id, episode_id, report_hash) DO NOTHING
  `);
  await transaction.execute(sql`
    UPDATE learning_episodes
    SET processing_phase = ${LearningProcessingPhase.ASSESSMENT_COMPLETE}, updated_at = now()
    WHERE id = ${input.episodeId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
      AND status = 'active'
      AND processing_phase = ${LearningProcessingPhase.ASSESSMENT_PENDING}
  `);
  // 评估完成 → 同事务入队 commit_requested（幂等键 commit:session:episode）。
  await transaction.execute(sql`
    INSERT INTO learning_session_processing_outbox (
      workspace_id, user_id, session_id, episode_id,
      command_type, payload, idempotency_key
    ) VALUES (
      ${input.workspaceId}, ${input.userId}, ${input.sessionId}, ${input.episodeId},
      'commit_requested',
      ${JSON.stringify({
        sessionId: input.sessionId,
        episodeId: input.episodeId,
        artifactId: input.artifactId,
      })},
      ${`commit:${input.sessionId}:${input.episodeId}`}
    )
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  `);
  return "processed";
}

async function loadAssessmentContextWithTransaction(
  input: LearningSessionAssessmentInput,
  transaction: SqlTransaction,
): Promise<AssessmentContext> {
  const artifactRows = (await transaction.execute(sql`
    SELECT id, session_id AS "sessionId", episode_id AS "episodeId",
           status, modality, revision, content_hash AS "contentHash",
           episode_target_fingerprint AS "episodeTargetFingerprint",
           payload, supersedes_artifact_id AS "supersedesArtifactId",
           correction_method AS "correctionMethod"
    FROM learning_response_artifacts
    WHERE id = ${input.artifactId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const artifactRow = artifactRows[0];
  if (!artifactRow) {
    throw new LearningSessionAssessmentError("artifact_not_found", "锁定 artifact 不存在");
  }
  if (
    String(artifactRow.sessionId) !== input.sessionId
    || String(artifactRow.episodeId) !== input.episodeId
  ) {
    throw new LearningSessionAssessmentError("session_or_episode_mismatch", "artifact 归属不匹配");
  }
  if (String(artifactRow.status) !== "locked") {
    throw new LearningSessionAssessmentError("artifact_not_locked", "仅锁定 artifact 可评测");
  }
  const { artifact, payload } = lockedArtifactFromRow(artifactRow);
  if (answerText(payload, String(artifactRow.modality)) === "") {
    throw new LearningSessionAssessmentError("empty_answer", "锁定 artifact 无回答文本");
  }

  const episodeRows = (await transaction.execute(sql`
    SELECT id, session_id AS "sessionId", key_point_id AS "keyPointId",
           status, processing_phase AS "processingPhase",
           rubric_targets AS "rubricTargets", model_id AS "modelId",
           episode_target_fingerprint AS "episodeTargetFingerprint"
    FROM learning_episodes
    WHERE id = ${input.episodeId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const episodeRow = episodeRows[0];
  if (!episodeRow || String(episodeRow.sessionId) !== input.sessionId) {
    throw new LearningSessionAssessmentError("episode_not_found", "Episode 不存在或归属不匹配");
  }
  const episodeTargetFingerprint = String(episodeRow.episodeTargetFingerprint ?? "");
  if (
    contextFingerprintMismatch(
      String(artifactRow.episodeTargetFingerprint ?? ""),
      episodeTargetFingerprint,
    )
  ) {
    throw new LearningSessionAssessmentError(
      "EPISODE_TARGET_MISMATCH",
      "artifact 与 Episode 的冻结内容指纹不一致，评估拒绝",
    );
  }
  const rubricTargets = Array.isArray(episodeRow.rubricTargets)
    ? episodeRow.rubricTargets
    : [];
  if (rubricTargets.length === 0) {
    throw new LearningSessionAssessmentError("rubric_targets_empty", "Episode 无 rubric targets");
  }

  const questionRows = (await transaction.execute(sql`
    SELECT claim
    FROM card_key_points
    WHERE id = ${String(episodeRow.keyPointId)}
      AND workspace_id = ${input.workspaceId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    workspaceId: input.workspaceId,
    userId: input.userId,
    artifact,
    artifactPayload: payload,
    artifactEpisodeTargetFingerprint: String(artifactRow.episodeTargetFingerprint ?? ""),
    episode: {
      id: String(episodeRow.id),
      sessionId: String(episodeRow.sessionId),
      status: String(episodeRow.status),
      processingPhase: String(episodeRow.processingPhase ?? LearningProcessingPhase.AWAITING_RESPONSE),
      keyPointId: String(episodeRow.keyPointId),
      rubricTargets,
      modelId: String(episodeRow.modelId ?? ""),
      episodeTargetFingerprint,
    },
    question: stringValue(questionRows[0]?.claim) ?? "",
  };
}

function contextFingerprintMismatch(artifactFingerprint: string, episodeFingerprint: string): boolean {
  return artifactFingerprint === "" || episodeFingerprint === "" || artifactFingerprint !== episodeFingerprint;
}

async function persistAssessmentBundleWithTransaction(
  input: LearningSessionAssessmentInput,
  bundle: AssessmentBundle,
  transaction: SqlTransaction,
): Promise<"processed" | "already_processed"> {
  const episodeRows = (await transaction.execute(sql`
    SELECT id, session_id AS "sessionId", status,
           processing_phase AS "processingPhase"
    FROM learning_episodes
    WHERE id = ${input.episodeId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
    FOR UPDATE
  `)) as unknown as Array<Record<string, unknown>>;
  const episode = episodeRows[0];
  if (!episode || String(episode.sessionId) !== input.sessionId) {
    throw new LearningSessionAssessmentError("episode_not_found", "Episode 不存在或归属不匹配");
  }
  const artifactRows = (await transaction.execute(sql`
    SELECT id, session_id AS "sessionId", episode_id AS "episodeId", status
    FROM learning_response_artifacts
    WHERE id = ${input.artifactId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
    FOR UPDATE
  `)) as unknown as Array<Record<string, unknown>>;
  const artifact = artifactRows[0];
  if (!artifact || String(artifact.sessionId) !== input.sessionId || String(artifact.episodeId) !== input.episodeId) {
    throw new LearningSessionAssessmentError("session_or_episode_mismatch", "artifact 归属不匹配");
  }
  if (String(artifact.status) !== "locked") {
    throw new LearningSessionAssessmentError("artifact_not_locked", "仅锁定 artifact 可评测");
  }

  const phase = String(episode.processingPhase ?? LearningProcessingPhase.AWAITING_RESPONSE);
  if (phase === LearningProcessingPhase.ASSESSMENT_COMPLETE) {
    const existingRows = (await transaction.execute(sql`
      SELECT id
      FROM learning_assessment_reports
      WHERE workspace_id = ${input.workspaceId}
        AND user_id = ${input.userId}
        AND episode_id = ${input.episodeId}
        AND report_hash = ${bundle.reportHash}
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    if (existingRows[0]) return "already_processed";
    throw new LearningSessionAssessmentError(
      "assessment_result_not_found",
      "Episode 已完成评估但报告不可重放",
    );
  }
  if (String(episode.status) !== LearningEpisodeStatus.ACTIVE || phase !== LearningProcessingPhase.ASSESSMENT_PENDING) {
    throw new LearningSessionAssessmentError(
      "episode_not_assessable",
      `Episode 当前阶段 ${phase} 不可评测`,
    );
  }

  await transaction.execute(sql`
    INSERT INTO learning_assessment_reports (
      session_id, episode_id, workspace_id, user_id,
      critic_version, reducer_version, assessment_source,
      rubric_assessments, report_hash, decision_hash
    ) VALUES (
      ${input.sessionId}, ${input.episodeId}, ${input.workspaceId}, ${input.userId},
      ${bundle.criticVersion}, 'rubric-session-reducer-v2', ${bundle.assessmentSource},
      ${JSON.stringify(bundle.assessments)}, ${bundle.reportHash}, ${bundle.decisionHash}
    )
    ON CONFLICT (workspace_id, episode_id, report_hash) DO NOTHING
  `);
  await transaction.execute(sql`
    UPDATE learning_episodes
    SET processing_phase = ${LearningProcessingPhase.ASSESSMENT_COMPLETE}, updated_at = now()
    WHERE id = ${input.episodeId}
      AND workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
      AND status = 'active'
      AND processing_phase = ${LearningProcessingPhase.ASSESSMENT_PENDING}
  `);
  // 评估完成 → 同事务入队 commit_requested（0081 已放行该 command_type；
  // payload 仅 scoped 标识符，幂等键 commit:session:episode）。API 侧
  // 消费方（commit-outbox）用 SECURITY DEFINER claim 函数跨 workspace 领取，
  // 执行 episode-commit 编排并在 commit 应用后触发 committed_change_display。
  await transaction.execute(sql`
    INSERT INTO learning_session_processing_outbox (
      workspace_id, user_id, session_id, episode_id,
      command_type, payload, idempotency_key
    ) VALUES (
      ${input.workspaceId}, ${input.userId}, ${input.sessionId}, ${input.episodeId},
      'commit_requested',
      ${JSON.stringify({
        sessionId: input.sessionId,
        episodeId: input.episodeId,
        artifactId: input.artifactId,
      })},
      ${`commit:${input.sessionId}:${input.episodeId}`}
    )
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
  `);
  return "processed";
}

export async function assessLearningSession(
  input: LearningSessionAssessmentInput,
): Promise<"processed" | "already_processed"> {
  const context = await withWorkerWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    (transaction) => loadAssessmentContextWithTransaction(input, transaction),
  );
  // Ending a session cancels its active Episode. There is no canonical result
  // to produce after that terminal transition; consume the identifier-only
  // command instead of retrying a permanently unassessable job forever.
  if (context.episode.status !== "active" || context.episode.processingPhase === "cancelled") {
    return "already_processed";
  }
  const assessed = await buildCriticAssessments(context);
  const failClosed = assessed.criticVersion === "diagnostic-fail-closed-v1";
  const decisionHash = !failClosed
    ? computeCriticDecisionHash({
      episodeId: input.episodeId,
      artifactId: input.artifactId,
      assessments: assessed.assessments,
      criticVersion: assessed.criticVersion,
      canonicalCommitEnabled: isCanonicalCommitEnabled(),
    })
    : computeFailClosedAssessmentDecisionHash({
      episodeId: input.episodeId,
      artifactId: input.artifactId,
      reducerResult: "not_assessable",
      canonicalCommitEnabled: isCanonicalCommitEnabled(),
    });
  const bundle: AssessmentBundle = {
    assessments: assessed.assessments,
    decisionHash,
    reportHash: failClosed
      ? computeAssessmentReportHash(input.episodeId, input.artifactId, decisionHash)
      : computeCriticReportHash(input.episodeId, input.artifactId, decisionHash, assessed.assessments),
    criticVersion: assessed.criticVersion,
    assessmentSource: assessed.source,
  };
  return withWorkerWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    (transaction) => persistAssessmentBundleWithTransaction(input, bundle, transaction),
  );
}

/** Outbox 死信阈值：attempts 达到该值后不再重试（转软死信，见 release 分支） */
export const ASSESSMENT_OUTBOX_MAX_ATTEMPTS = 8;
/** lease 续期间隔：lease 120s，处理中每 30s 刷新一次，防长任务被重复 claim */
const ASSESSMENT_OUTBOX_RENEW_INTERVAL_MS = 30_000;

export async function claimLearningAssessmentOutbox(
  workerId: string,
  leaseMs: number,
): Promise<AssessmentOutboxRow | null> {
  return db.transaction(async (transaction) => {
    // 0081 policy（0098 收紧版）：worker 分支要求 lease_owner IS NULL 或
    // lease_owner = app.worker_id。claim 事务内先设置 worker_id，使
    // claim 的 WITH CHECK（新行 lease_owner = workerId）通过租约约束。
    await transaction.execute(sql`
      SELECT pg_catalog.set_config('app.worker_id', ${workerId}, true)
    `);
    // 2026-08-11：时钟统一用 DB now()（应用时钟漂移会提前/延后认领）；
    // attempts 达到死信阈值的行不再 claim（等效软死信，见 process 的 [DEAD] 分支）。
    const rows = (await transaction.execute(sql`
      WITH candidate AS (
        SELECT id
        FROM learning_session_processing_outbox
        WHERE processed_at IS NULL
          AND command_type = 'assessment_requested'
          AND attempts < ${ASSESSMENT_OUTBOX_MAX_ATTEMPTS}
          AND available_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE learning_session_processing_outbox AS job
      SET attempts = job.attempts + 1,
          leased_at = now(), lease_owner = ${workerId},
          lease_expires_at = now() + ${leaseMs} * interval '1 millisecond',
          updated_at = now()
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.id, job.workspace_id AS "workspaceId",
        job.user_id AS "userId", job.session_id AS "sessionId",
        job.episode_id AS "episodeId", job.payload,
        job.attempts, job.lease_owner AS "leaseOwner"
    `)) as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    const payload = asRecord(row.payload);
    if (typeof payload.artifactId !== "string") {
      // 2026-08-11 修复：坏 payload 行不得抛错回滚——否则该行永远停在队头，
      // 每次 claim 都失败（队头阻塞，后续行全部饿死）。改为在 claim 事务内
      // 直接标记死信（available_at='infinity' 永不满足 claim 条件）。
      await transaction.execute(sql`
        UPDATE learning_session_processing_outbox
        SET available_at = 'infinity', leased_at = NULL, lease_owner = NULL,
            lease_expires_at = NULL, last_error = '[DEAD] payload missing artifactId',
            updated_at = now()
        WHERE id = ${row.id}
      `);
      return null;
    }
    return {
      id: String(row.id),
      workspaceId: String(row.workspaceId),
      userId: String(row.userId),
      sessionId: String(row.sessionId),
      episodeId: String(row.episodeId),
      artifactId: payload.artifactId,
      attempts: Number(row.attempts ?? 0),
      leaseOwner: String(row.leaseOwner),
    };
  });
}

export async function processLearningAssessmentOutboxJob(
  job: AssessmentOutboxRow,
): Promise<"processed" | "released"> {
  // 2026-08-11：lease 续期——长任务（多轮 LLM 调用 >120s）期间每 30s 刷新
  // lease_expires_at，避免被下一轮 tick 重复 claim 并发执行（幂等兜底不脏
  // 数据，但 provider 计费/耗时翻倍）。
  let renewTimer: NodeJS.Timeout | null = null;
  const renewLease = () => {
    renewTimer = setInterval(async () => {
      try {
        await db.transaction(async (transaction) => {
          await transaction.execute(sql`
            SELECT pg_catalog.set_config('app.worker_id', ${job.leaseOwner}, true)
          `);
          await transaction.execute(sql`
            UPDATE learning_session_processing_outbox
            SET lease_expires_at = now() + interval '2 minutes',
                updated_at = now()
            WHERE id = ${job.id} AND lease_owner = ${job.leaseOwner}
              AND processed_at IS NULL
          `);
        });
      } catch {
        // 续期失败不致命：lease 到期后由下一次 claim 回收重试
      }
    }, ASSESSMENT_OUTBOX_RENEW_INTERVAL_MS);
  };
  renewLease();
  try {
    const result = await assessLearningSession(job);
    if (result === "already_processed") {
      // 幂等命中（同一 episode/artifact 已处理过）：该行使命已完成，
      // 同样标记 processed 移出队列——否则 processed_at 保持 NULL 会
      // 再次被 claim → 无限空转（与原实现一致，只标记不重复评估）。
    }
    // 0081 policy（0098 收紧版）要求 lease_owner = app.worker_id：
    // markProcessed/release 的 USING（旧行 lease_owner）需匹配 worker_id，
    // 因此每条状态转换语句都在事务内先设置 app.worker_id。
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        SELECT pg_catalog.set_config('app.worker_id', ${job.leaseOwner}, true)
      `);
      await transaction.execute(sql`
        UPDATE learning_session_processing_outbox
        SET processed_at = now(), leased_at = NULL, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = now()
        WHERE id = ${job.id} AND lease_owner = ${job.leaseOwner}
          AND processed_at IS NULL
      `);
    });
    return "processed";
  } catch (error) {
    // last_error 落库脱敏：不用 error.message 原文（可能含 provider 细节/
    // 回答引用），改用结构化类别（与日志脱敏同策略）。
    const projected = sanitizeOperationalError(error);
    const lastErrorText = (
      `[${projected.category}${projected.code ? `:${projected.code}` : ""}] ${projected.name}`
    ).slice(0, 1000);
    // 2026-08-11：死信——attempts 达到阈值后 available_at 置为 infinity
    //（claim 的 available_at <= now() 永不满足），永久停止重试；last_error
    // 带 [DEAD] 前缀便于排障。此前无上限，永久失败任务每 60s 循环一次。
    const isDead = job.attempts >= ASSESSMENT_OUTBOX_MAX_ATTEMPTS;
    const deadMarker = isDead ? "[DEAD] " : "";
    // 2026-08-11 修复：退避用 DB 时钟（now() + interval）——此前 Date.now()
    // 应用时钟与 claim/死信判定的 DB 时钟不一致，漂移下退避时长失真。
    const retryDelayMs = Math.min(60_000, Math.max(1_000, job.attempts * 2_000));
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`
        SELECT pg_catalog.set_config('app.worker_id', ${job.leaseOwner}, true)
      `);
      if (isDead) {
        await transaction.execute(sql`
          UPDATE learning_session_processing_outbox
          SET available_at = 'infinity', leased_at = NULL, lease_owner = NULL,
              lease_expires_at = NULL, last_error = ${deadMarker + lastErrorText},
              updated_at = now()
          WHERE id = ${job.id} AND lease_owner = ${job.leaseOwner}
            AND processed_at IS NULL
        `);
      } else {
        await transaction.execute(sql`
          UPDATE learning_session_processing_outbox
          SET available_at = now() + ${retryDelayMs} * interval '1 millisecond',
              leased_at = NULL, lease_owner = NULL,
              lease_expires_at = NULL, last_error = ${deadMarker + lastErrorText},
              updated_at = now()
          WHERE id = ${job.id} AND lease_owner = ${job.leaseOwner}
            AND processed_at IS NULL
        `);
      }
    });
    return "released";
  } finally {
    if (renewTimer) clearInterval(renewTimer);
  }
}
