-- G-001: 为 jobs 表添加 lease_token 列。
-- claim 时生成不可变 UUID lease token 并写入 DB，
-- 完成/失败时以 (id, status='running', lease_token) 为条件原子提交。
-- 替代旧的 startedAt timestamp 比较，避免 DB 精度或序列化差异导致的 fencing 失败。
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lease_token" text;
