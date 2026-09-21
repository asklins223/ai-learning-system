-- 0247：给逐段语音结果加**阶段**列（0246 的下半场，方案 29 §4.9，抱怨 #4「语音经常没声音」）。
--
-- 0246 记的是服务端那一半：这一段有没有合成出来、多少字节、等了多久。它能证明的边界
-- 就是"音频字节交给了客户端"。而用户听到的"没声音"里有三种情形在这条线之后：
--   1. 字节到了，但客户端等太久（首段/段间截止先到）→ 那段被跳过；
--   2. 字节到了，解码或播放失败（AudioContext 未解锁、格式异常）；
--   3. 应用根本没开（这一半取段覆盖率已经能看出来）。
-- 情形 1/2 只有客户端知道自己发生了。以前它记着 `deadline` / `synth_failed` 两个原因
-- 却**一次也没往任何地方写**（0246 建表时就是按"下半场接线"设计的），于是这三类
-- 只能靠用户复述，修好了也没法证明修好了。
--
-- 为什么用一列 stage 而不是新表：三段链路对同一件事（一段语音的最终结局）负责，
-- 分成两张表会让"这一段到底死在哪一步"变成一个跨表 join，而 join 出来的结果
-- 与这一列的取值域完全同构。同一张表 + 一个阶段列，报表一句 GROUP BY 就够。
--
-- outcome 沿用既有词表，不新增取值：
--   ok = 这一段真的播完了；failed = 尝试过但没播出（超时/解码失败）；
--   rejected = 没尝试（音频被静音、窗口不可见）。具体原因在 error_code。
-- duration_ms 在 playback 阶段是"从发起取段到这段播完"，与 synth 阶段的
-- "引擎往返"不同义，所以两阶段的数**不能混在一起算分位数**（报表按 stage 分组）。
ALTER TABLE public.companion_tts_outcomes
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'synth';

ALTER TABLE public.companion_tts_outcomes
  DROP CONSTRAINT IF EXISTS companion_tts_outcomes_stage_check;
ALTER TABLE public.companion_tts_outcomes
  ADD CONSTRAINT companion_tts_outcomes_stage_check CHECK (stage IN ('synth', 'playback'));

-- 播放结果按 (run, segment) 幂等：客户端重发（弱网重试、页面刷新后补报）不该把
-- "这一段播过"变成三条。只约束 playback 阶段——同一段的合成可以有失败后重试的
-- 多行，那是引擎质量的历史，不是重复计数。
CREATE UNIQUE INDEX IF NOT EXISTS companion_tts_outcomes_playback_segment_unique_idx
  ON public.companion_tts_outcomes (run_id, segment_id)
  WHERE stage = 'playback';

-- 在线时段过滤用（"这一段播没播"只在看得到人的时间里才有意义）。
CREATE INDEX IF NOT EXISTS companion_tts_outcomes_stage_created_idx
  ON public.companion_tts_outcomes (stage, created_at DESC);

COMMENT ON COLUMN public.companion_tts_outcomes.stage IS
  'synth = 服务端合成那一半（0246）；playback = 客户端拿到字节之后的那一半（0247）';

-- 授权不变：这张表仍是只有 api 写、只有 api 读（0246 的注释说明了为什么不给 worker
-- 白名单）。加列不新增权限面，`infra/postgres/roles.sql` 三处清单都按表发放，无需同步。
