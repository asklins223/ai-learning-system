-- 0246：伴星语音合成的**逐段结果**表（方案 29 §4.9，抱怨 #4「语音经常没声音」的可审计化）。
--
-- 为什么需要它：今天能证明的只有 `voice.segment.ready` 事件（服务端"决定要说这一段"），
-- 而"这一段到底合成出来没有、多少字节、等了多久、被谁拒了"全都不知道——
-- 客户端 `companion-voice-playback.ts` 里明明记着 `deadline` / `synth_failed`
-- 两种失败原因，但它一次也没往任何地方写。于是"她经常没声音"只能靠人复述，
-- 修好了也没法证明修好了。这张表把链路变成可数的：每段一行，成败与耗时都在。
--
-- 授权注意：`infra/postgres/roles.sql` 在迁移**之后**跑 `REVOKE ALL` 再按白名单发放，
-- 且那份白名单有**三处**（GRANT 语句、函数权限断言、表权限矩阵）。只改这里的话，
-- 症状不是当场报错，而是"下一次重启容器才炸"（0238 的三支函数就是这么埋的）。
CREATE TABLE IF NOT EXISTS public.companion_tts_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  segment_id text NOT NULL,
  ordinal integer NOT NULL,
  -- ok = 返回了音频字节；rejected = 合成之前就被拒（找不到段/合同不符/回合已取消）；
  -- failed = 引擎侧失败（edge-tts 500、BrokenPipe、超时）。
  outcome text NOT NULL CHECK (outcome IN ('ok', 'rejected', 'failed')),
  -- 只存**分类码**（NOT_FOUND / UNSUPPORTED_CONTRACT / INVALID_REQUEST /
  -- TURN_CANCELLED / TTS_FAILED / provider 错误类名），不存原始异常：
  -- 异常文本可能带内部服务地址与配置。
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  engine text CHECK (engine IS NULL OR engine IN ('qwen', 'edge')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  bytes integer CHECK (bytes IS NULL OR bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 窗口指标（"最近 2 天音频完整率"）与单回合还原各一条。
CREATE INDEX IF NOT EXISTS companion_tts_outcomes_created_idx
  ON public.companion_tts_outcomes (created_at DESC);
CREATE INDEX IF NOT EXISTS companion_tts_outcomes_run_idx
  ON public.companion_tts_outcomes (run_id, ordinal);

ALTER TABLE public.companion_tts_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companion_tts_outcomes_workspace_isolation
  ON public.companion_tts_outcomes;
CREATE POLICY companion_tts_outcomes_workspace_isolation
  ON public.companion_tts_outcomes FOR ALL
  USING (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'
    OR (
      workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

-- 只有 api 写、也只有 api 读（合成发生在 api 进程内，报表也走 api）。
-- **不给 worker 授权**：`roles.sql` 里 api 是整库 blanket 授权、worker 是一份份显式
-- 白名单 + 权限矩阵断言，多给一份 worker 权限就要多改两处清单——而这张表现在
-- 没有任何 worker 侧读者。将来要做主动质量报表时再一起加（GRANT + 读集 + 矩阵）。
GRANT SELECT, INSERT ON public.companion_tts_outcomes TO ailearn_api;
