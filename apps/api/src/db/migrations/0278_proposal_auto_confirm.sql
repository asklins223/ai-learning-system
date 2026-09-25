-- 39d W2-4 #16：full 档的提案由服务端自动确认，需要一个"这张卡没有人在点"的标记。
-- 默认 false：今天所有在途提案与全部历史行都仍然是"等人点"，自动确认只对显式置真的行生效。
-- 不复用 origin 列：那一列装的是"提案从哪来"（实测有 menu 与 agent_tool 两种取值），
-- 把权限语义塞进去会让同一列有两个意思。
ALTER TABLE "companion_action_proposals" ADD COLUMN "auto_confirm" boolean NOT NULL DEFAULT false;
