# 项目 Feature Flag / 环境开关总清单

> 生成日期：2026-08-16
> 最近核对：2026-09-16（按代码真实读取方重写第一节；伴星/能力开关由门禁脚本强制）
> 扫描范围：`apps/api`、`apps/desktop-client`、`workers/ai-worker`、`packages/shared`
> 说明：本地调试阶段 flag 过多容易乱，本清单用于统一核对。标记：
> - **新** = 方案 16/20、V2、桌伴星/LearningRun
> - **旧** = v0.5/v0.6 既有或 AI 质量/基础设施既有
> - **测试/调试** = 仅测试或本地调试用
> - **基建/配置** = 数据库、密钥、端口、超时等非功能开关

---

## 一、能力开关（方案 16 / 20 / V2 / 伴星 / LearningRun）

**权威来源是代码，不是本表**：`.github/scripts/verify-companion-capability-config.mjs`
在 `make verify` / CI 中逐条断言「每个服务只声明它真实读取的开关」+「表达式精确等于
`${NAME:-默认值}`」+「dev 默认开、prod 默认关」。新增开关必须同时更新该脚本与两个
compose 文件，否则门禁直接失败。

| Flag | 读取方 | 默认（dev / prod） | 作用 |
| --- | --- | --- | --- |
| `LEARNING_RUN_ENABLED` | api | true / false | 方案 16 统一 LearningRun 能力总开关 |
| `CARD_GENERATION_V2_ENABLED` | api | true / false | V2 价值优先生成总开关；false 时 V2 路由/管线 fail-closed |
| `CARD_GENERATION_V2_LLM` | worker | true / false | V2 四阶段 LLM 模式；false 时走确定性占位管线 |
| `COMPANION_DIALOGUE_V1_ENABLED` | api + worker | true / false | 伴星文字对话能力（含 `session/current`、`history/search` 只读面） |
| `COMPANION_VOICE_DIALOGUE_V1_ENABLED` | api + worker | true / false | 半双工 ASR/TTS 语音对话 |
| `COMPANION_STREAMING_VOICE_V1_ENABLED` | api | false / false | 流式语音；阻塞未解除前两侧都保持关 |
| `COMPANION_JOURNEY_V2` | api | true / false | 伴星 Journey V2 + 交付/inbox/timeline 门禁 |
| `COMPANION_BRIDGE_V2` | api | true / false | 页面上下文桥（`/companion/bridge/contexts`） |
| `COMPANION_MEMORY_VECTOR_V1` | api + worker | true / false | 记忆向量检索 / embedding 重建 |
| `COMPANION_MEMORY_EXTRACTOR_V1` | worker | true / false | 对话记忆抽取（候选记忆唯一生产路径） |
| `COMPANION_SUMMARIZER_V1` | api + worker | true / false | 会话摘要 |
| `COMPANION_MEMORY_STAR_MAP_V1` | api | true / false | 记忆星图 |
| `COMPANION_PET_PROFILE_V1` | api | true / false | 桌宠画像 |
| `COMPANION_PROACTIVE_PERSONALIZED_V1` | api | true / false | 主动个性化 delivery |
| `COMPANION_DAILY_SUMMARY_V1` | api + worker | true / false | 每日总结 / 伴星日记 |
| `V2_PROVIDER_CALL_TIMEOUT_MS` | worker | - | V2 provider 调用超时 |
| `ALLOW_TEST_FETCH_IN_PRODUCTION` | api | false | 生产环境允许测试 fetch（安全闸，默认关） |

**已删除的死开关（2026-09-16）**：`COMPANION_PET_V1_ENABLED`、
`COMPANION_LIVE2D_V1_ENABLED`、`COMPANION_ACTION_BRIDGE_V1_ENABLED`。三者在
compose/.env 有声明，但全仓 TS 零引用（`grep process.env.<NAME>` 无命中）；前者的
唯一引用是本清单与门禁脚本自己的白名单。Live2D 呈现由桌面端 `WindowLive2D` 的模型
manifest 许可门禁（`commercialReleaseAllowed`）控制，不需要服务端开关。

**未纳入 compose 的服务端开关**：`COMPANION_DIALOGUE_V1_ENABLED` 之外，伴星模块内还有
若干常量型环境项（如 `COMPANION_EXPORT_MAX_ROWS`、`COMPANION_VOICE_MAX_AUDIO_BYTES`、
`COMPANION_AGENT_MAX_STEPS`），它们是**参数**不是能力开关，按需在 `.env` 覆盖即可。

---

## 二、旧功能开关（v0.5 / v0.6 / AI 质量既有）

| Flag | 端 | 新/旧 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| `PROMPT_CACHE_ENABLED` | API/Worker | 旧 | false | Provider prompt cache 开关 |
| `PROMPT_CACHE_PROVIDERS` | API/Worker | 旧 | dashscope | 允许 prompt cache 的 provider 白名单 |

---

## 三、测试 / 调试专用

| Flag | 端 | 新/旧 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| `V2_E2E_DEBUG_ERRORS` | E2E | 新 | false | V2 E2E 调试错误输出 |
| `V2_IT_KEEP_RUNS` | IT | 新 | false | V2 集成测试保留 run |
| `E2E_TEST_USER_EMAIL` | E2E | 旧 | - | E2E 测试账号 |
| `E2E_TEST_USER_PASSWORD` | E2E | 旧 | - | E2E 测试密码 |
| `SEED_DEMO_DATA` | API | 旧 | false | 是否种 demo 数据 |
| `NODE_TEST_CONTEXT` | 测试 | 旧 | - | Node 测试上下文 |
| `WORKER_DISABLE_AUTOSTART` | Worker | 旧 | false | 测试禁用 worker 自启动 |
| `WORKER_DISABLE_NOTIFY` | Worker | 旧 | false | 禁用 NOTIFY |
| `MIGRATION_COUNT` / `MIGRATIONS_FOLDER` / `MIN_READY_MIGRATION_CREATED_AT` | API | 旧 | - | 迁移测试/校验 |
| 各 `*_TEST_DATABASE_URL` | 测试 | 旧 | - | 测试数据库连接（含 `RLS_TEST_*`、`QUEUE_TEST_*`） |

---

## 四、Provider / AI 配置（旧基建）

| Flag | 端 | 新/旧 | 作用 |
| --- | --- | --- | --- |
| `AI_PLATFORMS_CONFIG` | API/Worker | 旧 | AI 平台配置 JSON 路径 |
| `DASHSCOPE_*` | API/Worker | 旧 | DashScope 模型/密钥/参数 |
| `OPENAI_COMPAT_*` | API/Worker | 旧 | OpenAI-compatible 模型/密钥/参数 |
| `SILICONFLOW_*` | API/Worker | 旧 | SiliconFlow 模型/密钥/参数 |
| `TOKENRHYTHM_API_KEY` | API/Worker | 旧 | TokenRhythm 密钥 |
| `ASSESSMENT_CRITIC_URL/KEY/MODEL` | API/Worker | 新 | LearningRun 独立 Critic 配置 |
| `MOCK_CONTEXT_WINDOW_TOKENS` | Worker | 旧 | Mock provider 上下文窗口 |
| `LLM_SAMPLE` | Worker | 旧 | LLM 采样参数 |

---

## 五、客户机构建期开关（Vite，构建时内联）

| Flag | 端 | 默认 | 作用 |
| --- | --- | --- | --- |
| ~~`VITE_HOME_SCENE_VARIANT`~~ | — | **不存在** | 2026-09-22 校正：全仓无任何读取点（只有 `apps/desktop-client/package.json:19` 的截图脚本给它赋值），`apps/desktop-client` 下也没有 `.env.development`；`HomeV2Provider` 在 `App.tsx:145` 无条件挂载。原先这一行的"home-v2.ts 读取 / dev 为 v2"两条都是假的。 |

---

## 六、基建 / 运行配置（非功能开关）

| 类别 | 示例 |
| --- | --- |
| 数据库 | `DATABASE_URL`、`DATABASE_URL_API`、`DATABASE_URL_WORKER`、`DATABASE_URL_MIGRATOR` |
| 端口/服务 | `PORT`、`WORKER_METRICS_PORT`、`CORS_ORIGIN`、`TRUST_PROXY` |
| 密钥/安全 | `AUTH_SURFACE_MANIFEST_SECRET`、`PROJECTION_CHECKPOINT_SECRET`、`LEARNING_DRAFT_ENC_KEY`、`EDGE_TTS_AUTH_TOKEN`、`MINIO_*`、`S3_*`、`STORAGE_ENDPOINT` |
| 限流 | `AUTH_RATE_LIMIT_STORE`（生产保持 `postgres`）、`AUTH_RATE_LIMIT_WINDOW_MS`、`AUTH_RATE_LIMIT_MAX_ATTEMPTS` |
| 超时/性能 | `WORKER_MODEL_TIMEOUT_MS`、`WORKER_PROVIDER_TIMEOUT_MS`、`WORKER_TIMEOUT_*`、`WORKER_MEMORY_LIMIT_MB`、`WORKER_DRAIN_TIMEOUT_MS`、`AI_ENDPOINT_RESPONSE_TIMEOUT_MS`、`QUEUE_CONCURRENCY`、`API_STATEMENT_TIMEOUT_MS`、`WORKER_STATEMENT_TIMEOUT_MS`、`TOPOLOGY_SNAPSHOT_CACHE_MS`、`EDGE_TTS_MAX_CONCURRENCY`、`QWEN_TTS_MAX_CONCURRENCY`、`V2_MAX_LLM_ATTEMPTS_PER_JOB` |
| 源抓取 | `SOURCE_FETCH_*` |
| 其他 | `NODE_ENV`、`LOG_LEVEL`、`GIT_COMMIT`、`ROUNDS`、`WORKSPACE_ID`、`VOICE_ASR_MODEL` |

---

## 七、本地调试建议

1. **能力开关**：dev 栈已在 `docker-compose.dev.yml` 默认开启（除 streaming voice）；
   **prod 栈不是"全部 false fail-closed"——这句话是错的，2026-09-22 按 `docker-compose.yml` 逐条数过改在这里**：
   它是**混合姿态**，两件事分开看：
   - **默认关**（能力类 4 支）：`LEARNING_RUN_ENABLED`、`CARD_GENERATION_V2_ENABLED`、
     `COMPANION_VOICE_DIALOGUE_V1_ENABLED`、`COMPANION_STREAMING_VOICE_V1_ENABLED`；
     另有 `CARD_GENERATION_V2_LLM`、`TRUST_PROXY`、`AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS`
     三支属于运行/安全参数而不是能力开关。全文件合计 `:-true` 13 支、`:-false` 7 支。
   - **默认开**（能力类 11 支，全为 `${...:-true}`）：`COMPANION_DIALOGUE_V1_ENABLED`、
     `COMPANION_JOURNEY_V2`、`COMPANION_BRIDGE_V2`、`COMPANION_MEMORY_VECTOR_V1`、
     `COMPANION_MEMORY_EXTRACTOR_V1`、`COMPANION_MEMORY_STAR_MAP_V1`、`COMPANION_PET_PROFILE_V1`、
     `COMPANION_THOUGHTS_V1`、`COMPANION_PROACTIVE_PERSONALIZED_V1`、`COMPANION_SUMMARIZER_V1`、
     `COMPANION_DAILY_SUMMARY_V1`。
     （另有两支非能力开关也默认 true：`AI_REQUIRE_CONFIGURED_PROVIDER`、`AUTH_COOKIE_SECURE`。）
   所以"生产上伴星是关着的"这个判断不成立；要按现状做决定，请以 compose 的字面默认值为准，
   并把"prod 应当全 fail-closed"当成一次**待做的收敛决定**，而不是已经实现的合同。
2. **旧功能开关**：保留但收敛到 compose 一处维护；能合并的尽量合并。
3. **测试/调试开关**：只出现在测试命令或 `.env.test`，不进 `docker-compose.dev.yml`。
4. **Provider 配置**：统一走 `AI_PLATFORMS_CONFIG`，不要再为每个 provider 拆散开关。
5. **伴星集成测试**：需要干净库，用
   `bash scripts/dev-disposable-db.sh ailearn_companion_it` +
   `make test-companion-integration-postgres COMPANION_HOME_TEST_DB=ailearn_companion_it`
   （17 个套件；共享开发库会因历史残留行假失败）。
