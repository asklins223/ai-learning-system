-- 0231: 补 ailearn_enqueue_companion_thoughts 的 EXECUTE 授权。
--
-- 0227 创建函数时漏授（对照 0171 日记调度函数 ailearn_enqueue_companion_daily_summaries
-- 的授权模式，那边授了 worker + migrator）：函数是 SECURITY DEFINER、属主 ailearn，
-- 默认只有属主可执行，而 worker 以 ailearn_worker 角色连接 → 念头调度 tick
-- （进程内 15min 节流）每次都报 permission denied，基础念头调度实际从未出队。
GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_thoughts() TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_thoughts() TO ailearn_migrator;
