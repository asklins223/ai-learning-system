-- 0176: 退役 V1 学习卡兼容层（Wave 2）——FK 改指 learning_objectives_v2
--
-- 决策：用户确认"旧版本学习卡数据兼容代码不再需要"（2026-08-17）。
-- 开发环境无生产数据；方案 16 的 V2 链路（LearningRun/Commit/Schedule）以
-- learning_objectives_v2 为稳定主体，key_point_id 从此直接引用 objective_id，
-- 不再依赖 legacy card_key_points alias 行。
--
-- 步骤：
--  1. 删除仅指向 V1 key point 的历史行（保留引用 objective 的行）；
--  2. learning_objectives_v2.objective_id 建立全局唯一约束（FK 目标）；
--  3. 全部 key_point_id FK 从 card_key_points(id) 改指 learning_objectives_v2(objective_id)，
--     删除带 workspace 的冗余复合 FK；
--  4. 清空 card_key_points / learning_cards（V1 卡 + alias 行，改指后无引用）；
--  5. 删除已无读者的兼容表（attachment sidecar / writer 命中探针 /
--     shadow namespace / 盲评 / cutover 事件）。
--
-- 幂等性：以 IF EXISTS / 存在性 DELETE 为主；重复执行不会破坏已改指约束。

--> statement-breakpoint

-- ─── 1. 清理仅引用 V1 key point 的历史行 ────────────────────────────────

DELETE FROM canonical_learning_event_outbox
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM practice_trail_event_outbox
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM learning_task_presentation_history
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM learning_run_private_contracts
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM learning_runs
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM review_attempts
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM review_schedules
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

DELETE FROM scheduling_shadow_decisions
WHERE key_point_id NOT IN (SELECT objective_id FROM learning_objectives_v2);

-- 纯 V1 域（旧 session/evidence/validation 域，随 V1 学习卡一起退役）：整表清空
DELETE FROM learning_session_practice_events;
DELETE FROM learning_episodes;
DELETE FROM learning_response_artifacts;
DELETE FROM evidences;
DELETE FROM validation_assistance_exposures;
DELETE FROM validation_events;
DELETE FROM validation_questions;
DELETE FROM validation_submissions;

-- V1 生成域（card_generation_runs 及其子表）：result_card_id 指向 learning_cards，
-- 随 V1 生成域整体退役清空
DELETE FROM card_generation_quality_reports;
DELETE FROM card_generation_candidates;
DELETE FROM card_generation_drafts;
DELETE FROM card_generation_units;
DELETE FROM card_generation_plans;
DELETE FROM card_generation_agent_events;
DELETE FROM card_generation_events;
DELETE FROM card_generation_source_bundles;
DELETE FROM card_generation_runs;

--> statement-breakpoint

-- ─── 2. objective_id 全局唯一约束（FK 目标）──────────────────────────────

ALTER TABLE learning_objectives_v2
  ADD CONSTRAINT lo_v2_objective_id_uk UNIQUE (objective_id);

--> statement-breakpoint

-- ─── 3. key_point_id FK 改指 learning_objectives_v2(objective_id) ────────

-- learning_runs（RESTRICT 保留：不允许删除仍被 Run 引用的 Objective）
ALTER TABLE learning_runs DROP CONSTRAINT IF EXISTS learning_runs_key_point_id_fkey;
ALTER TABLE learning_runs
  ADD CONSTRAINT learning_runs_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE RESTRICT;

ALTER TABLE learning_run_private_contracts DROP CONSTRAINT IF EXISTS learning_run_private_contracts_key_point_id_fkey;
ALTER TABLE learning_run_private_contracts
  ADD CONSTRAINT learning_run_private_contracts_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE learning_task_presentation_history DROP CONSTRAINT IF EXISTS learning_task_presentation_history_key_point_id_fkey;
ALTER TABLE learning_task_presentation_history
  ADD CONSTRAINT learning_task_presentation_history_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE learning_episodes DROP CONSTRAINT IF EXISTS learning_episodes_key_point_fk;
ALTER TABLE learning_episodes
  ADD CONSTRAINT learning_episodes_key_point_fk
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE learning_response_artifacts DROP CONSTRAINT IF EXISTS learning_response_artifacts_key_point_fk;
ALTER TABLE learning_response_artifacts
  ADD CONSTRAINT learning_response_artifacts_key_point_fk
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE learning_session_practice_events DROP CONSTRAINT IF EXISTS learning_session_practice_events_key_point_id_fkey;
ALTER TABLE learning_session_practice_events
  ADD CONSTRAINT learning_session_practice_events_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE canonical_learning_event_outbox DROP CONSTRAINT IF EXISTS canonical_learning_event_outbox_key_point_id_fkey;
ALTER TABLE canonical_learning_event_outbox
  ADD CONSTRAINT canonical_learning_event_outbox_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE practice_trail_event_outbox DROP CONSTRAINT IF EXISTS practice_trail_event_outbox_key_point_id_fkey;
ALTER TABLE practice_trail_event_outbox
  ADD CONSTRAINT practice_trail_event_outbox_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE review_attempts DROP CONSTRAINT IF EXISTS review_attempts_key_point_id_fkey;
ALTER TABLE review_attempts
  ADD CONSTRAINT review_attempts_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE SET NULL;

ALTER TABLE review_schedules DROP CONSTRAINT IF EXISTS review_schedules_key_point_id_fkey;
ALTER TABLE review_schedules
  ADD CONSTRAINT review_schedules_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE SET NULL;

ALTER TABLE scheduling_shadow_decisions DROP CONSTRAINT IF EXISTS scheduling_shadow_decisions_key_point_id_fkey;
ALTER TABLE scheduling_shadow_decisions
  ADD CONSTRAINT scheduling_shadow_decisions_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE SET NULL;

ALTER TABLE validation_assistance_exposures DROP CONSTRAINT IF EXISTS validation_assistance_exposures_key_point_id_fkey;
ALTER TABLE validation_assistance_exposures
  ADD CONSTRAINT validation_assistance_exposures_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE validation_events DROP CONSTRAINT IF EXISTS validation_events_key_point_id_card_key_points_id_fk;
ALTER TABLE validation_events DROP CONSTRAINT IF EXISTS validation_events_keypoint_workspace_fk;
ALTER TABLE validation_events
  ADD CONSTRAINT validation_events_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE SET NULL;

ALTER TABLE validation_questions DROP CONSTRAINT IF EXISTS validation_questions_key_point_id_fkey;
ALTER TABLE validation_questions
  ADD CONSTRAINT validation_questions_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE SET NULL;

ALTER TABLE validation_submissions DROP CONSTRAINT IF EXISTS validation_submissions_key_point_id_fkey;
ALTER TABLE validation_submissions
  ADD CONSTRAINT validation_submissions_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE SET NULL;

ALTER TABLE evidences DROP CONSTRAINT IF EXISTS evidences_key_point_id_card_key_points_id_fk;
ALTER TABLE evidences DROP CONSTRAINT IF EXISTS evidences_keypoint_workspace_fk;
ALTER TABLE evidences
  ADD CONSTRAINT evidences_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE key_point_prerequisites DROP CONSTRAINT IF EXISTS key_point_prerequisites_key_point_id_fkey;
ALTER TABLE key_point_prerequisites
  ADD CONSTRAINT key_point_prerequisites_key_point_id_fkey
  FOREIGN KEY (key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

ALTER TABLE key_point_prerequisites DROP CONSTRAINT IF EXISTS key_point_prerequisites_prerequisite_key_point_id_fkey;
ALTER TABLE key_point_prerequisites
  ADD CONSTRAINT key_point_prerequisites_prerequisite_key_point_id_fkey
  FOREIGN KEY (prerequisite_key_point_id) REFERENCES learning_objectives_v2(objective_id) ON DELETE CASCADE;

--> statement-breakpoint

-- ─── 4. 清空 V1 卡表（含 alias 行——FK 已改指，无引用）──────────────────

DELETE FROM card_key_points;
DELETE FROM learning_cards;

--> statement-breakpoint

-- ─── 5. 删除已无读者的兼容表 ────────────────────────────────────────────

DROP TABLE IF EXISTS legacy_target_snapshot_attachments_v2;
DROP TABLE IF EXISTS card_generation_legacy_writer_hits;
-- 依赖顺序：shadow namespace runs 先于 shadow namespaces
DROP TABLE IF EXISTS card_generation_shadow_namespace_runs;
DROP TABLE IF EXISTS card_generation_shadow_namespaces;
DROP TABLE IF EXISTS card_generation_blind_evaluations;
DROP TABLE IF EXISTS card_generation_cutover_events;
