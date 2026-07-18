# AI 原生学习系统 · v0.4（开发中）

按 [V0 Docker 全栈骨架实施计划](../.cursor/plans/v0_docker_全栈骨架_fe4974b5.plan.md) 实现的全栈学习系统。涵盖学习卡闭环、证据对齐、理解验证、复习计划、来源管理、搜索和基准测试。

## 先决条件

- Docker（>= 24）+ Docker Compose v2
- Node 20+（仅本地调试时需要，Docker 容器内自带）
- Make（macOS / Linux 自带）

> 不需要在本机安装 Postgres 或 Node 服务。MinIO 是可选的 `storage` profile，默认不会启动。

## 启动

仓库提供两个**独立**的 Compose 文件，不再把开发覆盖层叠加到生产配置上：

- `docker-compose.yml`：生产模式，API、Worker、Web 全部使用 `prod` target；应用容器以非 root 用户运行且没有源码挂载。
- `docker-compose.dev.yml`：仅限本机开发，使用固定的本地凭据、`dev` target 和源码热更新。

两种模式使用不同的 Compose 项目名和数据卷：生产为 `ailearn`，开发为 `ailearn-dev`。启动、停止或执行 `reset` 都只影响对应模式的数据；默认宿主机端口仍相同，如需同时运行，请先为其中一种模式设置不同的 `API_PORT` / `WEB_PORT`（开发模式还需避开 Postgres 的 `5432` 端口）。

### 生产模式

复制生产配置并设置必填值：

```bash
cp .env.example .env
# 编辑 .env，至少设置 Postgres 密码、三个角色密码和三个角色连接 URL
make config                           # 先验证生产配置
make up                               # 构建并启动生产镜像
make down-prod                        # 只停止生产项目，保留生产数据卷
```

`POSTGRES_PASSWORD`、`MIGRATOR_PASSWORD`、`API_PASSWORD`、`WORKER_PASSWORD` 以及
三个角色连接 URL 不能留空。例如：

```dotenv
POSTGRES_USER=ailearn
POSTGRES_PASSWORD=请替换为随机强密码
POSTGRES_DB=ailearn
MIGRATOR_PASSWORD=迁移角色随机强密码
API_PASSWORD=API角色随机强密码
WORKER_PASSWORD=Worker角色随机强密码
DATABASE_URL_MIGRATOR=postgres://ailearn_migrator:URL编码后的迁移密码@postgres:5432/ailearn
DATABASE_URL_API=postgres://ailearn_api:URL编码后的API密码@postgres:5432/ailearn
DATABASE_URL_WORKER=postgres://ailearn_worker:URL编码后的Worker密码@postgres:5432/ailearn
AI_CREDENTIAL_ENCRYPTION_KEY=使用openssl生成的32字节随机密钥
```

v0.4 生产 Compose 使用独立的 `ailearn_migrator`、`ailearn_api` 和
`ailearn_worker` 数据库角色。请同时设置三个角色密码和对应的
`DATABASE_URL_MIGRATOR`、`DATABASE_URL_API`、`DATABASE_URL_WORKER`；应用不会
在 `NODE_ENV=production` 下回退到共享 `DATABASE_URL`。认证使用 HttpOnly Cookie，
如果仅在本机通过明文 `http://localhost` 运行生产-like 栈，请把
`AUTH_COOKIE_SECURE=false`，真实 TLS 部署必须保持 `true`。

如果密码包含 `@`、`:`、`/`、`#` 等保留字符，请先进行 URL 编码。缺少必填变量时 Compose 会直接终止，不会使用开发密码。

个人中心保存用户 API Key 前还必须设置 `AI_CREDENTIAL_ENCRYPTION_KEY`。可用
`openssl rand -base64 32` 生成；该值应进入密钥管理系统并随数据库备份策略妥善保管。
更换或丢失它会导致已有个人 Key 无法解密。

第一次启动会构建 API、Worker、Web 三个镜像，预计 3-5 分钟。迁移服务会自动执行数据库迁移，但**不会自动创建账号**。

API 默认只绑定宿主机 `127.0.0.1:4000`，公网入口应统一经过 Web 或受控反向代理。`TRUST_PROXY` 默认仅信任 loopback、link-local 和私网代理，禁止在 API 端口可被公网直连时配置为 `true`。

等迁移完成后，在 `.env` 中设置 `OWNER_EMAIL` 和至少 12 位的 `OWNER_PASSWORD`，再显式创建 Owner：

```bash
make seed-owner
```

生产 seed 缺少邮箱或密码时会失败；不会回退为演示账号，也不会在日志中输出密码。

### 本机开发模式

开发配置无需 `.env`，会使用仅限本机的 Postgres 凭据：

```bash
make dev
make seed-demo                         # 显式创建本地演示账号
make down-dev                          # 只停止开发项目，保留开发数据卷
```

演示账号仅由 `make seed-demo` 创建：`owner@ailearn.local` / `ailearn_owner`。`SEED_DEMO_DATA=true` 在生产环境会被 seed 程序拒绝。

## 创建 Owner 账号

| 场景 | 命令 | 凭据来源 |
|---|---|---|
| 生产 | `make seed-owner` | `.env` 中的 `OWNER_EMAIL` / `OWNER_PASSWORD` |
| 本机开发演示 | `make seed-demo` | 显式启用的本地演示凭据 |

迁移由一次性 `migrate` 服务自动执行。无需进入 API 容器手工运行 `migrate.ts` 或 `seed.ts`。

查看执行状态：

```bash
docker compose ps -a migrate
docker compose logs migrate
```

生产 seed 的预期输出不包含明文密码：

```
Seeded owner: you@example.com
Workspace: Personal Workspace (<uuid>)
```

> 已有 owner 账号无需 reset：旧 SHA-256 密码在首次登录时自动升级为 bcrypt。
> 登录态有效期 7 天，重启容器不再失效。

## 打开产品

| 地址 | 说明 |
|---|---|
| http://localhost:3000 | Web 前端（默认进驾驶舱） |
| http://localhost:4000/health | API 健康检查 |
| http://localhost:9001 | MinIO console（仅启动 `storage` profile 后可用） |

生产环境使用 `.env` 中显式配置的 Owner 凭据；本机开发演示账号见上节。

## 跑一次 v0.4 核心闭环

1. 进 `/notes` → 「+ 新建笔记」
2. 在编辑器里粘贴 3-5 段正文（每段 60+ 字），让自动保存产生至少一个 `note_version`
3. 点右下的「生成学习卡」
4. 任务面板出现 generate_card → succeeded
5. 跳到 `/cards`，点击新生成的学习卡
6. 看每条 key_point 的证据 chip：
   - 绿色 = 硬证据（aligned，>= 85 分）
   - 黄色 = 软引用（soft，60-85 分）
   - 红色 = 未对齐（unaligned，< 60 分）
7. 点 chip 打开证据抽屉，看原文片段 + 对齐分数 + 三种操作（确认 / 降级 / 标记错误）

## 目录结构

```
.
├── docker-compose.yml           # 独立生产配置（prod target / 非 root / 无源码挂载）
├── docker-compose.dev.yml       # 独立本机开发配置（热更新 / 本地凭据）
├── Makefile                     # up / dev / seed / storage / reset / shell
├── .env.example
├── apps/
│   ├── api/                     # Fastify 后端 + Drizzle schema
│   └── web/                     # Next.js 前端
├── workers/
│   └── ai-worker/               # AI 后台 worker
├── packages/
│   └── shared/                  # 跨包类型 + Zod schema + 枚举
└── infra/
    ├── postgres/init.sql        # pg_trgm / uuid 扩展
    ├── postgres/roles.sql       # 生产数据库角色、授权矩阵与可执行校验
    ├── postgres/apply-roles.sh  # 安全注入角色密码并重放授权
    └── minio/README.md
```

## v0.4 验收对照

- [x] `docker compose up` 一条命令起所有服务（含 Worker）
- [x] owner 账号登录后能写笔记，自动保存产生不可变 note_version
- [x] 点"生成学习卡"后 30 秒内出现学习卡
- [x] 学习卡每条 key_point 显示证据 chip（aligned / soft / unaligned）
- [x] 点 chip 打开证据抽屉，能看见 quote + 原文片段并排
- [x] 切换 provider：mock 默认，dashscope 通过环境变量切换后跑通同一流程
- [x] 个人中心支持按用户配置 DashScope 或 OpenAI-compatible 地址、Key 与模型
- [x] 个人 API Key 使用 AES-256-GCM 加密落库，接口只返回末四位提示
- [x] 数据可一键 `make reset` 清空，重启后 schema 重建
- [x] README 写清楚：前置依赖、启动命令、目录结构、扩展点
- [x] 笔记版本不可变（F-006），自动保存和显式保存均创建新版本
- [x] 证据用户覆盖进入 effectiveAlignment 计算（F-009）
- [x] 作业有租约/回收/超时/优雅关停（F-010）
- [x] CI 包含 typecheck + lint + build + 基础测试（F-018）
- [x] Docker 镜像使用 npm ci + lockfile + 非 root 用户（F-027）
- [x] 生产迁移、API、Worker 使用三个独立数据库角色，应用角色没有 DDL 权限
- [x] 浏览器登录态使用 HttpOnly Cookie；写请求使用双提交 CSRF 校验
- [x] 生产登录/注册限流使用 PostgreSQL 共享计数器
- [x] Worker 超时会向 Provider 传播取消信号，并用租约围栏保护业务事务与搜索投影
- [x] AI 基准集不少于 30 篇；硬引用准确率门槛 90%，两项覆盖率门槛 85%
- [x] CI 对空库与 0012 升级库执行迁移，并演练 PostgreSQL 备份、恢复和权限重放

## 模型配置

### 个人配置（推荐）

服务端先设置稳定的 `AI_CREDENTIAL_ENCRYPTION_KEY` 并重启 API 与 Worker。用户登录后进入
`/settings` →「模型 API」，即可选择：

- `本地 Mock`：不访问外部服务，不需要 Key。
- `阿里云百炼 / DashScope`：填写官方公网 HTTPS Base URL、模型 id 和 API Key。推荐 Base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`；若 Qwen 3.5/3.6 仍填写旧 `/api/v1` 根路径，系统会自动切换到同域名的兼容协议。
- `OpenAI-compatible`：填写服务商的公网 HTTPS API 根地址（或完整
  `/chat/completions` 地址）、模型 id 和 API Key。

配置属于当前用户，同一工作区的其他成员不会继承。完整 Key 只在保存时提交，服务端以
AES-256-GCM 加密，后续读取只返回末四位提示；同一 Provider、同一 HTTPS Origin 下修改路径或
模型时可留空沿用，切换 Provider 或接口域名/端口必须重新填写 Key，避免把旧 Key 静默发送到
新地址。Worker 会按“个人配置 → 工作区配置 → 环境变量”选择 Provider。

表单中的“测试连接”会直接使用当前尚未保存的 Base URL、模型和 Key 发出一次固定的最小
`OK` 探针；Key 留空时仅可复用同一 Provider、同一 HTTPS Origin 已保存的密文。测试结果会区分 Key/权限错误、
地址或模型不存在、服务商限流/配额、响应格式不兼容、网络错误和超时。服务端不会读取学习
内容，也不会返回或保存模型回复；若工作区开启审计，只记录 `test_connection` 的模型、耗时
和结果。默认每个用户 5 分钟最多测试 5 次，单次 15 秒超时，可通过
`AI_MODEL_TEST_RATE_LIMIT_WINDOW_MS`、`AI_MODEL_TEST_RATE_LIMIT_MAX_ATTEMPTS` 和
`AI_MODEL_TEST_TIMEOUT_MS` 调整。

公网地址仍执行 DNS/IP 校验并固定连接 IP。Docker Desktop 可能把公网域名代理为
`198.18.0.0/15` 合成地址，开发 Compose 会显式启用兼容；正常 Linux 生产环境必须保持
`AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS=false`，仅在确认使用 Docker Desktop DNS 代理时手动开启。

个人配置不会绕过工作区治理：外部调用仍要求 Owner 开启“允许发送到外部模型”并签署 AI
同意；PII 脱敏和审计策略继续生效。自定义接口只接受公网 HTTPS，Worker 在连接前再次校验
DNS/IP 并固定目标地址，防止借模型地址访问内网。

### 系统回退配置

没有个人配置时，仍可通过 `.env` 设置系统默认 Provider：

```dotenv
AI_PROVIDER_CARD=dashscope
DASHSCOPE_API_KEY=sk-你的密钥
DASHSCOPE_MODEL=qwen-plus
# DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

修改环境变量后重启 Worker。该模式适合管理员提供统一模型；个人中心配置优先于它。

### 实现细节

- DashScope 调用层：`workers/ai-worker/src/lib/providers/dashscope.ts`
  - 直接调用 generation REST API，并把 Worker 的取消信号传给底层请求
  - 多轮 messages（system + user），温度 0.2
- OpenAI-compatible 调用层：`workers/ai-worker/src/lib/providers/openai-compatible.ts`
  - 使用标准 `chat/completions` 请求结构
  - DNS/IP 公网校验、连接地址固定、响应体大小限制
- 输出用 prompt 约束并经容错 JSON 解析，再通过共享 Zod schema；校验失败时任务进入重试/失败流程

### 验证

打开 driver log：

```bash
docker compose logs -f worker                              # 生产模式
docker compose -f docker-compose.dev.yml logs -f worker    # 开发模式
```

跑一篇笔记，端到端后应看到类似：

```
running generate_card
card persisted {"cardId":"...","keyPoints":5}
evidence aligned {"alignment":"aligned","score":100,"method":"exact"}
```

如果出现 `401` / `invalid api-key`，检查个人中心的 Base URL、model id 和 Key；系统回退模式则检查 `.env` 是否被正确加载。

### Evidence 对齐算法升级

`apps/api/src/modules/evidence/align.ts` 的两阶段匹配器：

1. 字符级 exact 子串匹配
2. 字符 trigram Jaccard 相似度 + 滑动窗口

升级建议：
- 接 pgvector + embedding，给 quote 向量化做 top-k 检索
- 给 `UserNoteBlock` 加 token 级偏移，做字符级 fuzzy search（pg_trgm 支持）

### Source 输入

v0.4 已支持文本、Markdown、代码和 URL 来源。URL 抓取由 Worker 执行，包含
协议限制、DNS 多地址校验、IP 固定、重定向重校验、响应大小与超时限制；解析结果写入
`source_segments`，可继续创建可追溯笔记。PDF 与图片 OCR 仍属于后续扩展能力。

## 已实现的功能（v0.4）

`jobs` 表已支持 `align_evidence`、`evaluate_validation`、`parse_source`：

- `generate_validation_question`
- `evaluate_validation_answer`
- `schedule_review`

`review_schedules` 和 `validation_events` 表已经预建。

## 开发常见问题

### 端口冲突

修改当前模式对应的 Compose 文件端口映射。生产配置对公网暴露 Web，API 仅绑定宿主机回环地址；Postgres 的宿主机端口仅存在于 `docker-compose.dev.yml`：

```yaml
ports:
  - "3001:3000"   # 例如把 Web 宿主机端口改为 3001
```

### 修改代码后没有生效

生产模式不会挂载 API、Worker 或 Web 源码。修改代码后再次执行 `make up`，命令中的 `--build` 会重建并替换容器：

```bash
make up
```

需要持续热更新时使用 `make dev`。开发模式会挂载 API、Worker、Web 以及 shared/db 源码。

### Worker 看不到新代码

只有开发模式的 Worker 使用 tsx watch。编辑 `workers/ai-worker/src/` 后会自动重启；更改依赖后运行 `make rebuild-dev && make dev`。生产模式更改后运行 `make up` 重建镜像。

### 启用对象存储

生产模式先在 `.env` 中设置非空的 `MINIO_ROOT_USER` 和 `MINIO_ROOT_PASSWORD`，然后运行：

```bash
make storage
```

凭据为空时 MinIO 会立即退出，不会回退到镜像默认凭据。本机开发可用 `make storage-dev`，其固定凭据仅用于 localhost。

### Reset 数据库

```bash
make reset       # 生产模式，需要有效 .env
make reset-dev   # 本机开发模式
```

命令会对相应 Compose 项目执行 `down -v`，只清空该模式自己的数据卷，然后直接重新构建并启动，无需再执行 `make up`。清库后账号也被删除：生产模式重新运行 `make seed-owner`，开发模式重新运行 `make seed-demo`。

只停止服务但保留数据时，使用明确区分环境的命令：

```bash
make down-prod   # 生产项目 ailearn
make down-dev    # 开发项目 ailearn-dev
```

`make down` 是兼容旧用法的生产模式别名，等同于 `make down-prod`；它不会停止开发项目，也不会操作开发数据卷。

### PostgreSQL 备份与恢复演练

工作区 JSON 导出不能替代数据库级备份。以下命令使用默认的 `ailearn` 管理用户和数据库名；
如果 `.env` 修改过它们，请替换命令中的值。恢复应先落到新数据库，校验完成后再制定切换窗口：

```bash
docker compose exec -T postgres \
  pg_dump -U ailearn -d ailearn --no-owner --no-privileges > ailearn-backup.sql

docker compose exec -T postgres createdb -U ailearn ailearn_restore_check
docker compose exec -T postgres \
  psql -U ailearn -d ailearn_restore_check --set=ON_ERROR_STOP=1 < ailearn-backup.sql

# 恢复出来的对象需要重新归属 migrator，并重放 API/Worker 最小权限矩阵
docker compose run --rm --no-deps \
  -e POSTGRES_DB=ailearn_restore_check \
  -e REQUIRE_RLS_DISABLED=true \
  role-grants

docker compose exec -T postgres \
  psql -U ailearn -d ailearn_restore_check -Atc \
  'SELECT count(*) FROM drizzle.__drizzle_migrations'
```

CI 的 `Production Images & Compose Smoke` 会自动创建有用户、个人模型配置、笔记、学习卡、
任务、搜索投影和 AI 审计记录的快照，恢复到新库后逐表比对 11 张核心表，并验证全部迁移记录。备份文件应按生产
数据等级加密、限制访问并设置保留期。

### 看日志

```bash
make logs                     # 全部
docker compose logs -f api    # 生产模式 API（需要有效 .env）
docker compose logs -f worker # 生产模式 Worker（需要有效 .env）
```

## 后续版本规划

完整范围、里程碑和验收标准见 [`AI学习系统-v0.4-版本实施计划-2026-07-17.md`](./AI学习系统-v0.4-版本实施计划-2026-07-17.md)。当前仍处于 v0.4 开发阶段；发布前必须把本工作区变更纳入一个 clean checkout，并通过迁移矩阵、受限数据库角色、Worker 竞争、备份恢复和生产 Compose smoke 验收。
