import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { ArtifactType } from "@ailearn/shared";
import * as schema from "./index.ts";

const expectedTables = [
  "ai_artifacts",
  "ai_audit_log",
  "assistant_deliveries",
  "assistant_memory_embeddings",
  "assistant_memory_items",
  "assistant_page_contexts",
  "auth_rate_limits",
  "benchmark_labels",
  "benchmark_reports",
  "candidate_evidence_binding_plans_v2",
  "canonical_learning_event_outbox",
  "card_activation_receipts_v2",
  "card_candidate_feedback_v2",
  "card_candidate_lineage_v2",
  "card_candidate_quality_reports_v2",
  "card_content_capability_state",
  "card_domain_events_v2",
  "card_exposure_ledger_v2",
  "card_generation_agent_events",
  "card_generation_candidate_evidence",
  "card_generation_candidates",
  "card_generation_candidates_v2",
  "card_generation_cutover_events",
  "card_generation_drafts",
  "card_generation_events",
  "card_generation_events_v2",
  "card_generation_input_snapshots_v2",
  "card_generation_plans",
  "card_generation_plans_v2",
  "card_generation_post_activation_consumptions",
  "card_generation_quality_reports",
  "card_generation_run_outbox_v2",
  "card_generation_runs",
  "card_generation_runs_v2",
  "card_generation_semantic_specs_v2",
  "card_generation_source_bundle_members",
  "card_generation_source_bundles",
  "card_generation_units",
  "card_key_points",
  "companion_account_invitations",
  "companion_action_proposals",
  "companion_action_runs",
  "companion_audit",
  "companion_conversations",
  "companion_daily_summaries",
  "companion_invitation_ledger",
  "companion_journey_pending_events",
  "companion_journeys",
  "companion_messages",
  "companion_proactive_deliveries",
  "companion_runtime_fences",
  "companion_sandbox_namespaces",
  "companion_stream_events",
  "companion_turn_runs",
  "companion_voice_artifacts",
  "conversation_summaries",
  "evidence_eligibility_states_v2",
  "evidence_overrides",
  "evidence_redactions_v2",
  "evidence_snapshots_v2",
  "evidences",
  "initial_validation_reminders_v2",
  "interaction_qualifications",
  "invite_codes",
  "jobs",
  "key_point_prerequisites",
  "learning_activity_leases",
  "learning_artifacts",
  "learning_assessment_reports",
  "learning_assessments",
  "learning_card_publication_revisions_v2",
  "learning_card_revisions_v2",
  "learning_card_sets",
  "learning_cards",
  "learning_cards_v2",
  "learning_episodes",
  "learning_exposure_dependency_ledger",
  "learning_exposures_v2",
  "learning_metric_events",
  "learning_objective_equivalence_reports_v2",
  "learning_objective_evidence_bindings_v2",
  "learning_objective_lineage_v2",
  "learning_objective_private_contracts_v2",
  "learning_objective_revision_equivalence_v2",
  "learning_objective_revisions_v2",
  "learning_objectives_v2",
  "learning_outbox_events",
  "learning_response_artifacts",
  "learning_run_action_ledger",
  "learning_run_events",
  "learning_run_idempotency",
  "learning_run_private_contracts",
  "learning_run_processing_outbox",
  "learning_runs",
  "learning_session_practice_events",
  "learning_session_probes",
  "learning_session_processing_outbox",
  "learning_sessions",
  "learning_target_snapshots_v2",
  "learning_task_disclosure_profiles",
  "learning_task_drafts",
  "learning_task_presentation_history",
  "learning_task_private_solutions",
  "learning_task_safety_reports",
  "learning_task_variants",
  "learning_tasks",
  "learning_tutor_action_nonces",
  "learning_tutor_detours",
  "learning_tutor_permissions",
  "learning_unit_exposure",
  "legacy_target_snapshot_attachments_v2",
  "memory_links",
  "memory_usage_log",
  "note_blocks",
  "note_evidence_embeddings",
  "note_evidence_spans",
  "note_image_assets",
  "note_image_evidence_units",
  "note_image_insights",
  "note_versions",
  "notes",
  "onboarding_states",
  "pet_profiles",
  "practice_trail_event_outbox",
  "provisional_candidates",
  "review_attempts",
  "review_schedules",
  "scheduling_shadow_decisions",
  "search_documents",
  "semantic_support_reports_v2",
  "sessions",
  "source_segments",
  "sources",
  "understanding_change_sets",
  "understanding_events",
  "understanding_projection_checkpoints",
  "understanding_route_plans",
  "user_companion_account_state",
  "user_companion_onboarding",
  "user_learning_preferences",
  "users",
  "validation_action_commands",
  "validation_assistance_exposures",
  "validation_events",
  "validation_point_assessments",
  "validation_quality_signals",
  "validation_question_rubric_items",
  "validation_questions",
  "validation_submission_jobs",
  "validation_submissions",
  "workspace_members",
  "workspaces",
];

describe("database schema package contract", () => {
  it("exports every runtime table exactly once", () => {
    const tableNames = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableName(table as any))
      .sort();

    assert.deepEqual(tableNames, expectedTables);
    assert.equal(new Set(tableNames).size, tableNames.length);
  });

  it("keeps tenant and lifecycle columns on the core persisted entities", () => {
    for (const [table, lifecycleColumn] of [
      [schema.notes, "createdAt"],
      [schema.learningCards, "createdAt"],
      [schema.evidences, "createdAt"],
      [schema.reviewAttempts, "createdAt"],
      [schema.cardGenerationRuns, "createdAt"],
      [schema.jobs, "scheduledAt"],
    ] as const) {
      const columns = getTableColumns(table) as Record<string, unknown>;
      assert.ok(columns.id, `${getTableName(table)} must have id`);
      assert.ok(columns.workspaceId, `${getTableName(table)} must have workspaceId`);
      assert.ok(columns[lifecycleColumn], `${getTableName(table)} must have ${lifecycleColumn}`);
    }
  });

  it("keeps generation runs separate from leased execution jobs", () => {
    const runColumns = getTableColumns(schema.cardGenerationRuns) as Record<string, unknown>;
    const jobColumns = getTableColumns(schema.jobs) as Record<string, unknown>;

    for (const column of [
      "generationEpoch",
      "blockManifest",
      "assetManifest",
      "status",
      "stage",
      "stateVersion",
      "nextEventSequence",
    ]) {
      assert.ok(runColumns[column], `card_generation_runs must have ${column}`);
    }
    assert.ok(jobColumns.generationRunId, "jobs must link to a generation run");
    assert.ok(jobColumns.resourceClass, "jobs must declare a resource class");
    assert.ok(jobColumns.priority, "jobs must declare a priority");
  });

  it("models the result contract and card-set member constraints", () => {
    const cardConfig = getTableConfig(schema.learningCards);
    const runConfig = getTableConfig(schema.cardGenerationRuns);
    const cardIndexNames = new Set(
      cardConfig.indexes.map((index) => index.config.name),
    );
    const cardCheckNames = new Set(cardConfig.checks.map((check) => check.name));
    const runCheckNames = new Set(runConfig.checks.map((check) => check.name));

    assert.ok(
      cardIndexNames.has("learning_cards_generation_set_identity_unique_idx"),
    );
    assert.ok(cardIndexNames.has("learning_cards_set_scope_key_unique_idx"));
    assert.ok(cardCheckNames.has("learning_cards_card_set_shape_check"));
    assert.ok(
      runCheckNames.has("card_generation_runs_result_contract_check"),
    );
  });

  it("exports PostgreSQL enum columns with non-empty values", () => {
    const enums = [
      schema.sourceStatusEnum,
      schema.evidenceAlignmentEnum,
      schema.validationOutcomeEnum,
      schema.cardStatusEnum,
      schema.jobStatusEnum,
      schema.artifactStatusEnum,
      schema.artifactTypeEnum,
      schema.reviewStatusEnum,
    ];
    for (const pgEnum of enums) {
      assert.ok(pgEnum.enumValues.length > 0);
      assert.equal(new Set(pgEnum.enumValues).size, pgEnum.enumValues.length);
    }

    assert.deepEqual(
      [...schema.artifactTypeEnum.enumValues].sort(),
      Object.values(ArtifactType).sort(),
      "artifact_type schema must stay aligned with the shared ArtifactType contract",
    );
  });
});
