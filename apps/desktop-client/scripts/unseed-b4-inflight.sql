-- 清掉 seed-b4-inflight.sql 造出来的那一个批次：只按自己的 idempotency_key 认行，
-- 不碰任何别的批次（库里同时有别人在用的 review_ready 批次）。
BEGIN;

DELETE FROM card_generation_candidates_v2
WHERE run_id IN (SELECT id FROM card_generation_runs_v2 WHERE idempotency_key = 'b4-live-probe-2026-09-22');

DELETE FROM card_generation_plans_v2
WHERE run_id IN (SELECT id FROM card_generation_runs_v2 WHERE idempotency_key = 'b4-live-probe-2026-09-22');

DELETE FROM card_generation_run_progress_v2
WHERE run_id IN (SELECT id FROM card_generation_runs_v2 WHERE idempotency_key = 'b4-live-probe-2026-09-22');

DELETE FROM card_generation_runs_v2 WHERE idempotency_key = 'b4-live-probe-2026-09-22';

-- 这两篇是量测过程中在应用里新建的空笔记（正文没落库，见 §66），一并删掉。
DELETE FROM notes WHERE id IN (
  '8b88de46-4f2e-41cb-8d37-7b075b8d6429',
  '90743627-3f0e-4b81-bc60-395533e172d3'
);

COMMIT;

SELECT 'runs_left' AS what, count(*) FROM card_generation_runs_v2 WHERE idempotency_key = 'b4-live-probe-2026-09-22'
UNION ALL SELECT 'notes_left', count(*) FROM notes WHERE id IN (
  '8b88de46-4f2e-41cb-8d37-7b075b8d6429','90743627-3f0e-4b81-bc60-395533e172d3')
UNION ALL SELECT 'active_notes', count(*) FROM notes WHERE workspace_id='97550966-adf4-47fa-8d91-f83eae9ebfc0' AND deleted_at IS NULL
UNION ALL SELECT 'inflight_runs', count(*) FROM card_generation_runs_v2 WHERE status IN ('queued','source_sealing','planning','authoring','checking');
