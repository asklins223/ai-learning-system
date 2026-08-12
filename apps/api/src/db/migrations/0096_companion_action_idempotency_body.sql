-- P5 §6.7：菜单 proposal 幂等键必须绑定请求体。
-- 允许同 key 同 body 重放原始响应，同时拒绝同 key 的不同请求。
ALTER TABLE public.companion_action_proposals
  ADD COLUMN IF NOT EXISTS request_body_sha256 char(64);
