-- 0262: 修 `workspaces_epoch_bump` 的触发时机——改名/换 owner 没有抬 epoch。
--
-- 0261 把空间自身的边界变更写成 `BEFORE UPDATE` 触发器，并在函数里
-- `NEW.workspace_epoch := OLD.workspace_epoch + 1`。实测（dev 库，改名一次）：
-- **epoch 停在 1 没动**。
--
-- 原因是 `NEW` 是一个记录变量，对它的字段赋值在 plpgsql 里只改这份局部副本；
-- 要让修改落到行上必须 `RETURN NEW`。而这里还叠了另一件事：`workspace_epoch`
-- 自己也走 `ailearn_bump_epoch_on_workspace_change` 的分支判断——`NEW.workspace_epoch`
-- 与 `OLD` 不同时会再抬一次，于是"改个名字 +2"。
--
-- 改成 `AFTER UPDATE` + 复用唯一的抬 epoch 实现（`ailearn_bump_workspace_epoch`）：
-- 与成员表那条触发器同形状，只有一条抬 epoch 的路径，也就没有"两次 +1"的可能。
-- 顺序是安全的：AFTER 触发器跑在同一条语句的事务里，读到的是刚写下的行。

CREATE OR REPLACE FUNCTION public.ailearn_bump_epoch_on_workspace_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- 只看**边界性**字段。`workspace_epoch` 自身的变化不算边界变更——否则
  -- "抬一次 epoch"会自我触发第二次。
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.workspace_type IS DISTINCT FROM OLD.workspace_type THEN
    PERFORM public.ailearn_bump_workspace_epoch(NEW.id);
  END IF;
  RETURN NULL;
END;
$function$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS workspaces_epoch_bump ON public.workspaces;
CREATE TRIGGER workspaces_epoch_bump
  AFTER UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_bump_epoch_on_workspace_change();

--> statement-breakpoint

-- ─── 验证：这次必须真的动，而且只 +1 ────────────────────────────────

DO $$
DECLARE
  v_ws uuid;
  v_before integer;
  v_after_rename integer;
  v_after_noop integer;
  v_name text;
BEGIN
  SELECT id, workspace_epoch, name INTO v_ws, v_before, v_name FROM public.workspaces LIMIT 1;
  IF v_ws IS NULL THEN
    RAISE NOTICE 'workspaces 为空，跳过行为验证';
    RETURN;
  END IF;

  UPDATE public.workspaces SET name = name || ' ' WHERE id = v_ws;
  SELECT workspace_epoch INTO v_after_rename FROM public.workspaces WHERE id = v_ws;
  IF v_after_rename <> v_before + 1 THEN
    RAISE EXCEPTION '改名后 epoch 不是 +1（% -> %）', v_before, v_after_rename;
  END IF;

  UPDATE public.workspaces SET workspace_epoch = workspace_epoch WHERE id = v_ws;
  SELECT workspace_epoch INTO v_after_noop FROM public.workspaces WHERE id = v_ws;
  IF v_after_noop <> v_after_rename THEN
    RAISE EXCEPTION '与边界无关的写入也抬了 epoch（% -> %）', v_after_rename, v_after_noop;
  END IF;

  -- 还原名字（这一下再 +1，epoch 单调，无所谓）。
  UPDATE public.workspaces SET name = v_name WHERE id = v_ws;

  RAISE NOTICE 'workspace_epoch 触发时机修复验证通过';
END
$$;
