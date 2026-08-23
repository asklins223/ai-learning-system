-- 0180：为 V2 不可变触发器增加受控旁路（集成测试/维护场景）。
--
-- 背景（2026-08-23）：0135 起三组不可变触发器无条件拒绝 UPDATE/DELETE，
-- 导致集成测试共享 fixture 的清理（v2-card-fixture.ts cleanup）在真实 PG 上
-- 必然失败——这是"集成测试真实 PG 全绿"签收遗留的直接原因。
--
-- 方案：三个触发器函数统一改为在事务级 GUC `app.allow_history_mutation='on'`
-- 时放行，否则维持原 RAISE 行为与错误文案。旁路特征：
-- - set_config(..., true) 为事务级（set_local 语义），事务结束自动失效；
-- - 生产应用代码（api/worker）永不设置该 GUC，不可变保证对运行链路不变；
-- - 仅供集成测试清理与显式维护脚本使用，使用处必须注释说明。
--
-- 幂等：CREATE OR REPLACE，可安全重放。

CREATE OR REPLACE FUNCTION public.prevent_objective_revision_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'learning_objective_revisions_v2 is immutable: % operation not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.prevent_publication_revision_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'learning_card_publication_revisions_v2 is immutable: % operation not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.prevent_immutable_v2_row_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- 该函数被多张 V2 表共用（evidence_snapshots_v2 等，见 0138），错误文案与原实现一致。
  RAISE EXCEPTION 'immutable_v2_row: % rows on % cannot be modified',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
