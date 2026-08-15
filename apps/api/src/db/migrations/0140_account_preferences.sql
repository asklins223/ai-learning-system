-- 方案 16 §10.3：CompanionAccountPreferencesV2 子集
-- interventionLevel（主动介入强度）+ quietHours（静默时段，账号级跨设备）。
-- responsePreference 已由 user_learning_preferences（answer-mode-preference）承载；
-- voiceOutputEnabled 已由 animation_voice_off.voice_off 承载；不重复建列。

ALTER TABLE user_companion_account_state
  ADD COLUMN intervention_level text NOT NULL DEFAULT 'moderate'
    CHECK (intervention_level IN ('quiet', 'moderate', 'active')),
  ADD COLUMN quiet_hours jsonb;

COMMENT ON COLUMN user_companion_account_state.intervention_level IS
  '主动介入强度（方案 16 §10.2）：quiet=每日 0 条（首邀/可恢复故障除外）、moderate=每日 3 条、active=每日 6 条。';
COMMENT ON COLUMN user_companion_account_state.quiet_hours IS
  '静默时段 { startLocal, endLocal, timezone }；时段内抑制全部主动 cue（方案 16 §10.2）。';
