# 项目 Feature Flag / 环境开关总清单

> 生成日期：2026-08-16
> 扫描范围：`apps/api`、`apps/web`、`workers/ai-worker`、`packages/shared`
> 说明：本地调试阶段 flag 过多容易乱，本清单用于统一核对。标记：
> - **新** = 方案 16/20、V2、桌宠/伴星/LearningRun 近期新增
> - **旧** = v0.5/v0.6 既有或 AI 质量/基础设施既有
> - **测试/调试** = 仅测试或本地调试用
> - **基建/配置** = 数据库、密钥、端口、超时等非功能开关

---

## 一、新功能开关（方案 16 / 20 / V2 / 桌宠伴星 / LearningRun）

| Flag | 端 | 新/旧 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| `CARD_GENERATION_V2_ENABLED` | API/Worker | 新 | false | V2 价值优先生成总开关；false 时 V2 路由/管线 fail-closed |
| `NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED` | Web | 新 | false | Web 端 V2 生成入口开关 |
| `CARD_GENERATION_V2_LLM` | API/Worker | 新 | false | V2 四阶段 LLM 模式；false 时走确定性占位管线 |
| `CARD_GENERATION_V1_WRITER_ENABLED` | API | 新 | false | C8 停写闸：V2 开启后是否保留 V1 writer |
| `CARD_GENERATION_V2_MAX_INFLIGHT_RUNS` | API | 新 | 3 | V2 在途生成并发上限 |
| `CARD_GENERATION_V2_DAILY_RUN_LIMIT` | API | 新 | 50 | V2 每日生成次数上限 |
| `PROJECTION_KP_PAGE_SIZE` | API | 新 | 400 | 星图投影 Key Point 分页大小 |
| `LEARNING_RUN_V1` | API | 新 | false | 方案 16 统一 LearningRun 能力总开关 |
| `NEXT_PUBLIC_LEARNING_RUN_V1` | Web | 新 | false | Web 端 LearningRun 入口开关 |
| `LEARNING_SESSION_V2_INTERNAL` | API | 新 | false | 学习会话 V2 内部验证开关 |
| `LEARNING_SESSION_CANONICAL_COMMIT_ENABLED` | API | 新 | false | 正式学习结果/Commit 写权限开关 |
| `LEARNING_SESSION_ASSESSMENT_CRITIC_ENABLED` | API/Worker | 新 | false | 独立 Assessment Critic 开关 |
| `LEARNING_SESSION_ASSESSMENT_OUTBOX_WORKER_ENABLED` | Worker | 新 | true | Assessment outbox worker 开关（默认不关闭） |
| `LEARNING_SESSION_ASSESSMENT_OUTBOX_CONCURRENCY` | Worker | 新 | 1 | Assessment outbox 并发数 |
| `COMPANION_JOURNEY_V2` | API/Worker | 新 | false | 桌宠 Journey V2 服务端开关 |
| `NEXT_PUBLIC_COMPANION_JOURNEY_V2` | Web | 新 | false | Web 端 Journey V2 开关 |
| `COMPANION_BRIDGE_V2` | API | 新 | false | Main↔Pet Bridge V2 服务端开关 |
| `COMPANION_ACTION_BRIDGE_V1_ENABLED` | API/Worker | 新 | false | 工具网关/学习动作桥开关 |
| `COMPANION_PET_V1_ENABLED` | API/Worker | 新 | false | 桌宠 Pet surface 能力开关 |
| `NEXT_PUBLIC_COMPANION_PET_ENABLED` | Web | 新 | false | Web 端桌宠入口开关 |
| `COMPANION_DIALOGUE_V1_ENABLED` | API/Worker | 新 | false | 桌宠文字对话能力开关 |
| `COMPANION_VOICE_DIALOGUE_V1_ENABLED` | API/Worker | 新 | false | 桌宠语音对话能力开关 |
| `COMPANION_STREAMING_VOICE_V1_ENABLED` | API/Worker | 新 | false | 流式语音能力开关 |
| `COMPANION_LIVE2D_V1_ENABLED` | API | 新 | false | Live2D 角色能力开关 |
| `COMPANION_MEMORY_VECTOR_V1` | API/Worker | 新 | false | 记忆向量/检索能力开关 |
| `COMPANION_MEMORY_EXTRACTOR_V1` | Worker | 新 | false | 记忆抽取能力开关 |
| `COMPANION_SUMMARIZER_V1` | Worker | 新 | false | 对话总结能力开关 |
| `COMPANION_DAILY_SUMMARY_V1` | API/Worker | 新 | false | 每日总结能力开关 |
| `COMPANION_PET_PROFILE_V1` | API/Worker | 新 | false | 桌宠画像能力开关 |
| `COMPANION_PROACTIVE_PERSONALIZED_V1` | API/Worker | 新 | false | 主动个性化 delivery 开关 |
| `NEXT_PUBLIC_COMPANION_SHELL_ENABLED` | Web | 新 | false | 全局伴星壳开关 |
| `NEXT_PUBLIC_REVIEW_VOICE_ENTRY_ENABLED` | Web | 新 | false | 复习页语音入口开关 |
| `NEXT_PUBLIC_STAR_MAP_ACTION_V1` | Web | 新 | false | 星图行动面开关 |
| `NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED` | Web | 新 | false | Agent 活动流控制台开关 |
| `NEXT_PUBLIC_COMPANION_V2_INTERNAL` | Web | 新 | false | Companion V2 内部接口开关 |
| `V2_PROVIDER_CALL_TIMEOUT_MS` | Worker | 新 | - | V2 provider 调用超时 |
| `ALLOW_MOCK_IN_PRODUCTION` | API/Worker | 新 | false | 生产环境允许 mock provider（安全闸，默认关） |
| `ALLOW_TEST_FETCH_IN_PRODUCTION` | API | 新 | false | 生产环境允许测试 fetch（安全闸，默认关） |

---

## 二、旧功能开关（v0.5 / v0.6 / AI 质量既有）

| Flag | 端 | 新/旧 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| `AI_QUESTION_V1_ENABLED` | API/Worker | 旧 | false | AI 出题能力开关 |
| `NEXT_PUBLIC_AI_QUESTION_V1_ENABLED` | Web | 旧 | false | Web AI 出题入口开关 |
| `RUBRIC_EVALUATION_V1_ENABLED` | API/Worker | 旧 | false | Rubric 评估能力开关 |
| `NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED` | Web | 旧 | false | Web Rubric 入口开关 |
| `CARD_REPAIR_V1_ENABLED` | API/Worker | 旧 | false | 条件卡修复能力开关 |
| `NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED` | Web | 旧 | false | 旧 CardSet Deck UI 开关 |
| `NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED` | Web | 旧 | false | Question-first UI 开关 |
| `SCHEDULER_POLICY_VERSION` | API/Worker | 旧 | discrete-v1 | 调度策略版本 |
| `FSRS_SHADOW_ENABLED` | API/Worker | 旧 | false | FSRS shadow 决策写入开关 |
| `PROMPT_CACHE_ENABLED` | API/Worker | 旧 | false | Provider prompt cache 开关 |
| `PROMPT_CACHE_PROVIDERS` | API/Worker | 旧 | dashscope | 允许 prompt cache 的 provider 白名单 |
| `HYBRID_SEARCH_ENABLED` | API/Worker | 旧 | false | 混合检索开关 |
| `HYBRID_SEARCH_MODE` | API/Worker | 旧 | hybrid | 混合检索模式 |
| `GENERATION_FEEDBACK_COLLECTION_ENABLED` | API/Worker | 旧 | false | 生成反馈采集开关 |
| `FEEDBACK_REGENERATION_ENABLED` | API/Worker | 旧 | false | 反馈驱动重新生成开关 |
| `VISION_UNDERSTANDING_ENABLED` | API/Worker | 旧 | false | 图片视觉理解开关（高成本/隐私） |
| `VISION_IMAGE_BUDGET_PER_RUN` | API/Worker | 旧 | 10 | 每 run 视觉图片数上限 |
| `VISION_IMAGE_MAX_BASE64_BYTES` | API/Worker | 旧 | 1MB | 单图 base64 大小上限 |
| `FAST_PATH_ENABLED` | API/Worker | 旧 | false | Fast 路径灰度总开关 |
| `FAST_PATH_ROLLOUT_PERCENT` | API/Worker | 旧 | 0 | Fast 路径放量百分比 |
| `PLANNED_PATH_ENABLED` | API/Worker | 旧 | false | Planned 路径灰度总开关 |
| `PLANNED_PATH_ROLLOUT_PERCENT` | API/Worker | 旧 | 0 | Planned 路径放量百分比 |
| `AI_QUESTION_V1_ENABLED`（shared） | Shared | 旧 | false | 同上（shared 封装） |

---

## 三、测试 / 调试专用

| Flag | 端 | 新/旧 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| `CARD_GENERATION_TEST_ADMIN_URL` | API | 新 | - | V2 测试 admin URL |
| `CARD_GEN_RUN_TEST_LOOP_MS` | API | 旧 | - | 测试轮询间隔 |
| `V2_E2E_DEBUG_ERRORS` | E2E | 新 | false | V2 E2E 调试错误输出 |
| `V2_IT_KEEP_RUNS` | IT | 新 | false | V2 集成测试保留 run |
| `E2E_TEST_USER_EMAIL` | E2E | 旧 | - | E2E 测试账号 |
| `E2E_TEST_USER_PASSWORD` | E2E | 旧 | - | E2E 测试密码 |
| `SEED_DEMO_DATA` | API | 旧 | false | 是否种 demo 数据 |
| `NODE_TEST_CONTEXT` | 测试 | 旧 | - | Node 测试上下文 |
| `WORKER_DISABLE_AUTOSTART` | Worker | 旧 | false | 测试禁用 worker 自启动 |
| `WORKER_DISABLE_NOTIFY` | Worker | 旧 | false | 禁用 NOTIFY |
| `MIGRATION_COUNT` / `MIGRATIONS_FOLDER` / `MIN_READY_MIGRATION_CREATED_AT` | API | 旧 | - | 迁移测试/校验 |
| 各 `*_TEST_DATABASE_URL` | 测试 | 旧 | - | 测试数据库连接 |

---

## 四、Provider / AI 配置（旧基建）

| Flag | 端 | 新/旧 | 作用 |
| --- | --- | --- | --- |
| `AI_PLATFORMS_CONFIG` | API/Worker | 旧 | AI 平台配置 JSON 路径 |
| `AI_PROVIDER_AGENT_TURN` / `AI_PROVIDER_CARD` / `AI_PROVIDER_EMBEDDING` / `AI_PROVIDER_VISION` / `AI_PROVIDER_TEXT_GENERATION` / `AI_PROVIDER_RERANK` / `AI_PROVIDER_REPRO_LOG` | Worker | 旧 | 各角色 provider 选择 |
| `DASHSCOPE_*` | API/Worker | 旧 | DashScope 模型/密钥/参数 |
| `OPENAI_COMPAT_*` | API/Worker | 旧 | OpenAI-compatible 模型/密钥/参数 |
| `SILICONFLOW_*` | API/Worker | 旧 | SiliconFlow 模型/密钥/参数 |
| `TOKENRHYTHM_API_KEY` | API/Worker | 旧 | TokenRhythm 密钥 |
| `ASSESSMENT_CRITIC_URL/KEY/MODEL` | API/Worker | 新 | LearningRun 独立 Critic 配置 |
| `MOCK_CONTEXT_WINDOW_TOKENS` | Worker | 旧 | Mock provider 上下文窗口 |
| `LLM_SAMPLE` | Worker | 旧 | LLM 采样参数 |

---

## 五、基建 / 运行配置（非功能开关）

| 类别 | 示例 |
| --- | --- |
| 数据库 | `DATABASE_URL`、`DATABASE_URL_API`、`DATABASE_URL_WORKER`、`DATABASE_URL_MIGRATOR` |
| 端口/服务 | `PORT`、`INTERNAL_API_URL`、`API_INTERNAL_URL`、`WORKER_METRICS_PORT`、`CORS_ORIGIN`、`TRUST_PROXY` |
| 密钥/安全 | `AUTH_SURFACE_MANIFEST_SECRET`、`PROJECTION_CHECKPOINT_SECRET`、`LEARNING_DRAFT_ENC_KEY`、`EDGE_TTS_AUTH_TOKEN`、`MINIO_*`、`S3_*`、`STORAGE_ENDPOINT` |
| 超时/性能 | `WORKER_MODEL_TIMEOUT_MS`、`WORKER_PROVIDER_TIMEOUT_MS`、`WORKER_TIMEOUT_*`、`WORKER_MEMORY_LIMIT_MB`、`WORKER_DRAIN_TIMEOUT_MS`、`AI_WORKER_HTTP_POOL_*`、`AI_ENDPOINT_RESPONSE_TIMEOUT_MS`、`QUEUE_CONCURRENCY` |
| 源抓取 | `SOURCE_FETCH_*` |
| 其他 | `NODE_ENV`、`LOG_LEVEL`、`GIT_COMMIT`、`ROUNDS`、`WORKSPACE_ID`、`VOICE_ASR_MODEL` |

---

## 六、本地调试建议

1. **新功能开关**：本地开发建议统一在 `docker-compose.dev.yml` 默认 `true`，不要每次手改。
2. **旧功能开关**：保留但收敛到 compose 一处维护；能合并的尽量合并。
3. **测试/调试开关**：只出现在测试命令或 `.env.test`，不进 `docker-compose.dev.yml`。
4. **Provider 配置**：统一走 `AI_PLATFORMS_CONFIG`，不要再为每个 provider 拆散开关。
5. **灰度类开关**（`FAST_PATH_*`、`PLANNED_PATH_*`）：本地默认关，避免干扰主流程。
