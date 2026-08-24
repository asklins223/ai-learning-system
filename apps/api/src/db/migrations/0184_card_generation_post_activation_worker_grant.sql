-- 0184: 修复现有库中 post-activation 对账台账的 worker 授权。
--
-- 0162 已声明该表属于 API + Worker 共享边界，但部分长期运行的开发库
-- 在 worker 角色创建前应用了 0162，因此只保留了 ailearn_api 的直接授权。
-- Worker 进入 post-activation 消费阶段时会因权限错误持续重试；本迁移
-- 只补齐缺失授权，不改变个人投影（该消费者仍由 0162 的 CHECK 约束为 0）。

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.card_generation_post_activation_consumptions
TO ailearn_api, ailearn_worker;
