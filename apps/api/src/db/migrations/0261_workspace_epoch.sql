-- 0260: 服务端的空间边界令牌——`workspaces.workspace_epoch`。
--
-- 审查原文（1.3 节，低）：**服务端无 `workspaceEpoch` 概念（只有硬编码 1）→ 无法做
-- "某空间全端强制下线"**。客户端那一侧是真的（切空间时主进程换 token、递增 epoch、
-- 清投影缓存），但那个数字只活在客户端：服务端没有"这个空间的边界变了"这件事的记录，
-- 于是改 AI 外发政策、改空间名、撤销某台设备这些动作**无法即时生效**——只能等客户端
-- 自己下次切空间。
--
-- 这一列把那个令牌变成真的事实源：
--   - `capability-projection` 与 `session.workspaceEpoch` 都读它，不再写死 1；
--   - 边界一变（成员加入/退出/被移除、AI 同意或外发政策改变、空间改名）就 +1；
--   - 客户端拿着旧 epoch 打请求时，主进程的 `assertEpoch` 判它过期
--     （`stale_workspace` / `resync_first`），门禁重读会话拿到新 epoch 再继续。
--
-- 为什么是"服务端 +1、客户端跟随"而不是服务端主动推送：桌面端只有一个长连接入口
-- （网关），而 epoch 的比较点已经在 IPC 边界上（fail-closed）。把数字变成真的，
-- 不需要再造一条推送通道。
--
-- 幂等与并发：`+1` 用 SQL 表达式而不是"读出来加一写回"，两个并发请求不会丢更新。
-- 触发器写在表上而不是散在各调用点：审查反复撞到的那件事就是"某个写点忘了做这件事"。

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS workspace_epoch integer NOT NULL DEFAULT 1;

--> statement-breakpoint

COMMENT ON COLUMN public.workspaces.workspace_epoch IS
  '空间边界令牌（0260）。边界变更时 +1；客户端拿旧值请求会被判 stale_workspace 并重读会话。';

--> statement-breakpoint

-- 边界变更的**唯一**实现：给一个空间抬 epoch。
CREATE OR REPLACE FUNCTION public.ailearn_bump_workspace_epoch(target_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_epoch integer;
BEGIN
  UPDATE public.workspaces
     SET workspace_epoch = workspace_epoch + 1
   WHERE id = target_workspace_id
  RETURNING workspace_epoch INTO v_epoch;
  RETURN v_epoch;
END;
$function$;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.ailearn_bump_workspace_epoch(uuid) TO ailearn_api;

--> statement-breakpoint

-- 成员表：加入 / 退出 / 被移除 / 角色改变都改边界。
--
-- 为什么放在触发器而不是调用点：`workspace_members` 的写入点有六处（注册、建协作
-- 空间、接受邀请、退出、被移除、重置恢复账号），逐个加"记得抬 epoch"正是审查说的
-- 那种"靠开发者手写"的约定。触发器让"成员变了"与"边界变了"在数据库层同义。
CREATE OR REPLACE FUNCTION public.ailearn_bump_epoch_on_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.ailearn_bump_workspace_epoch(NEW.workspace_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.ailearn_bump_workspace_epoch(OLD.workspace_id);
    RETURN OLD;
  ELSE
    -- 软退出是 UPDATE left_at，角色变更也是 UPDATE——两者都改边界。
    IF NEW.left_at IS DISTINCT FROM OLD.left_at
       OR NEW.role IS DISTINCT FROM OLD.role THEN
      PERFORM public.ailearn_bump_workspace_epoch(NEW.workspace_id);
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS workspace_members_epoch_bump ON public.workspace_members;
CREATE TRIGGER workspace_members_epoch_bump
  AFTER INSERT OR UPDATE OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_bump_epoch_on_membership_change();

--> statement-breakpoint

-- 账号级 AI 同意 / 外发政策：审查 4.5 说这是"每一次 AI 调用"的授权前提，
-- 改了它必须让所有在线的端重新读一次边界。
CREATE OR REPLACE FUNCTION public.ailearn_bump_epoch_on_ai_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_workspace_id uuid;
BEGIN
  IF NEW.consent_version IS DISTINCT FROM OLD.consent_version
     OR NEW.data_policy IS DISTINCT FROM OLD.data_policy
     OR NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    -- 账号级设置影响这个人所在的**每一个**空间。
    FOR v_workspace_id IN
      SELECT m.workspace_id FROM public.workspace_members m
       WHERE m.user_id = NEW.user_id AND m.left_at IS NULL
    LOOP
      PERFORM public.ailearn_bump_workspace_epoch(v_workspace_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS user_ai_settings_epoch_bump ON public.user_ai_settings;
CREATE TRIGGER user_ai_settings_epoch_bump
  AFTER UPDATE ON public.user_ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_bump_epoch_on_ai_settings_change();

--> statement-breakpoint

-- 空间自身的边界：改名、换 owner、换类型。
CREATE OR REPLACE FUNCTION public.ailearn_bump_epoch_on_workspace_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.workspace_type IS DISTINCT FROM OLD.workspace_type THEN
    NEW.workspace_epoch := OLD.workspace_epoch + 1;
  END IF;
  RETURN NEW;
END;
$function$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS workspaces_epoch_bump ON public.workspaces;
CREATE TRIGGER workspaces_epoch_bump
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_bump_epoch_on_workspace_change();

--> statement-breakpoint

-- ─── 验证：边界真的会动，而且只在边界动的时候动 ──────────────────────

DO $$
DECLARE
  v_ws uuid;
  v_before integer;
  v_after integer;
  v_unchanged integer;
BEGIN
  SELECT id, workspace_epoch INTO v_ws, v_before FROM public.workspaces LIMIT 1;
  IF v_ws IS NULL THEN
    RAISE NOTICE 'workspaces 为空，跳过行为验证（新库在首次注册后才会走这段）';
    RETURN;
  END IF;

  -- 正向：改名字必须抬 epoch。
  UPDATE public.workspaces SET name = name || ' ' WHERE id = v_ws;
  SELECT workspace_epoch INTO v_after FROM public.workspaces WHERE id = v_ws;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION '改名没有抬 epoch（% -> %）', v_before, v_after;
  END IF;

  -- 负向：一次与边界无关的 UPDATE 不许抬。
  UPDATE public.workspaces SET workspace_epoch = workspace_epoch WHERE id = v_ws;
  SELECT workspace_epoch INTO v_unchanged FROM public.workspaces WHERE id = v_ws;
  IF v_unchanged <> v_after THEN
    RAISE EXCEPTION '与边界无关的写入也抬了 epoch（% -> %）', v_after, v_unchanged;
  END IF;

  -- 恢复名字（这一下又会 +1，无所谓：epoch 是单调的）。
  UPDATE public.workspaces SET name = rtrim(name) WHERE id = v_ws;

  RAISE NOTICE 'workspace_epoch 行为验证通过（当前值 %）', (SELECT workspace_epoch FROM public.workspaces WHERE id = v_ws);
END
$$;
