-- 0235: 补齐 ailearn_worker 对 assistant_thoughts 的 GRANT（方案 29 §9.14）。
--
-- 现象（用户抱怨 #8「完全没感知到伴星的主动提醒」）：
--   companion_thought job 全部 dead，last_error 只有脱敏后的
--   "operational_error:database:Error"；assistant_thoughts 恒 0 行。
--   真实原因在 dev 日志的 `cause` 字段里：
--       permission denied for table assistant_thoughts
--
-- 根因是**这个仓库的一个复发陷阱**，不是 0227 写漏了：
--   0227 第 69-70 行本来就写了
--     GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_thoughts TO ailearn_worker;
--     GRANT ... TO ailearn_api;
--   但迁移跑的时候 role-bootstrap 可能还没建出 ailearn_worker，GRANT 落空。
--   结果是**相邻两行 GRANT 一行生效一行没生效**——库里现在能看到
--     relacl = {ailearn_migrator=..., ailearn_api=arwd/...}   ← 只有 api，没有 worker
--   同一个坑 0085（learning worker grants repair）与 0091（companion worker grants）
--   已经踩过两次并各打了一支 repair 迁移；dev 栈又**没有** docker-compose.yml 里
--   那个 role-grants 一次性服务（它只建角色、不补表权限，见 apply-roles.sh），
--   所以每次重置 dev 库都会重新暴露一次。
--
-- 本迁移同样按 repair 模式写：GRANT 幂等，重复执行无害；角色不存在时跳过而不是
-- 让整个迁移失败（否则 dev 栈在 role-bootstrap 之前起 migrate 会直接卡死）。
--
-- 注：`companion_proactive_deliveries` 也在 worker 无授权的清单里，但那张表
-- **没有任何代码引用**（方案 16 审计 §824/§829 已记为"保留历史数据"，主动投递
-- 实际走 assistant_deliveries 的 durable inbox/ACK，见方案 19）。给它补授权等于
-- 给死表续命，所以这里不授；表本身的清理另案（见方案 29 §9.14）。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailearn_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_thoughts TO ailearn_worker;
  END IF;
END $$;
