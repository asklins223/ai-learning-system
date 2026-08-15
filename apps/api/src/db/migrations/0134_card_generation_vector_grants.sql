-- 0134_card_generation_vector_grants.sql
-- 2026-08-14（方案 16 e2e）：worker 插入 note_evidence_embeddings 时
-- `permission denied for function vector`——`'[...]'::vector` 文本字面量
-- 转换实际走 vector 的 input function `public.vector_in`（pg_cast 中无
-- text→vector cast，I/O 转换调用 input function），而非 vector(...) 本身。
-- 0010 及后续迁移 REVOKE 了 PUBLIC，表级 GRANT（0112）不覆盖函数 EXECUTE。
-- 注意：roles.sql 每次 bootstrap 会 REVOKE 并重放，本迁移与其并存，
-- 双方都加（grant 重复执行无副作用）；worker 函数白名单校验也已同步。
-- ailearn_api 无 embeddings 写路径，不授权（roles.sql api 白名单校验会拒绝）。
-- 幂等：GRANT 重复执行无副作用。

GRANT EXECUTE ON FUNCTION public.vector_in(cstring, oid, integer) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.vector(vector, integer, boolean) TO ailearn_worker;
