-- 0065: AI 平台解析收敛为单一配置源
-- 移除个人 BYOK 配置表（含加密 Key 密文，功能下线预期内）
DROP TABLE IF EXISTS user_ai_model_configs;

-- 移除工作区固定平台列（存量 pin 值均为系统默认快照，无保留价值）
ALTER TABLE workspaces DROP COLUMN IF EXISTS ai_provider;
