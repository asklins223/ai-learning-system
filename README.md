# AI Learning System

AI Learning System 是一个面向个人学习的 AI 原生知识系统。它把资料、笔记、学习卡、证据引用、理解验证和复习计划连接成一条可追溯的学习闭环。

当前版本：`v0.5.0`

## 核心能力

- 文本、Markdown、代码和 URL 来源采集与解析
- 笔记编辑、自动保存和不可变版本记录
- AI 学习卡生成与证据对齐
- 理解验证、复习计划和学习记录
- 全文搜索、来源追踪和理解关系图
- 用户级模型配置：Mock、DashScope、OpenAI-compatible
- 模型连接测试：校验接口、Key、模型权限和响应协议
- API Key 服务端加密保存，页面只显示末四位
- HttpOnly Cookie、CSRF、登录限流和最小权限数据库角色

## 技术栈

| 模块 | 技术 |
| --- | --- |
| Web | Next.js 15、React 19、TypeScript |
| API | Fastify 5、Drizzle ORM、Zod |
| Worker | Node.js、TypeScript、独立后台任务进程 |
| 数据库 | PostgreSQL 16 |
| 对象存储 | MinIO，可选 |
| 运行方式 | Docker Compose |

## 快速开始

### 环境要求

- Docker 24 或更高版本
- Docker Compose v2
- Make

本机开发不需要单独安装 PostgreSQL。

### 1. 启动开发环境

```bash
git clone https://github.com/asklins223/ai-learning-system.git
cd ai-learning-system
make dev
```

首次构建需要下载镜像和依赖，通常需要几分钟。数据库迁移会自动执行。

### 2. 创建演示账号

```bash
make seed-demo
```

开发环境演示账号：

```text
邮箱：owner@ailearn.local
密码：ailearn_owner
```

该账号仅用于本机开发，生产环境不会自动创建演示账号。

### 3. 打开应用

| 地址 | 用途 |
| --- | --- |
| http://localhost:3000 | Web 应用 |
| http://localhost:4000/health | API 存活检查 |
| http://localhost:4000/ready | API 就绪检查 |

## 配置个人 AI 模型

登录后进入“个人中心 → 模型 API”，可以选择：

- `本地 Mock`：不访问外部模型，不需要 API Key。
- `阿里云百炼 / DashScope`：填写官方 HTTPS Base URL、模型 ID 和 API Key。
- `OpenAI-compatible`：填写兼容 `chat/completions` 协议的 HTTPS 接口、模型 ID 和 API Key。

推荐的 DashScope Base URL：

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

保存前可以点击“测试连接”。系统会发送一个固定的最小请求，用于验证：

- 接口是否可以访问
- API Key 是否有效
- 当前账号是否有模型权限或可用额度
- 模型 ID 和接口协议是否匹配

连接测试不会使用学习内容，也不会保存或返回模型生成正文。个人 API Key 使用 AES-256-GCM 加密后写入数据库；后续读取只返回末四位提示。

用户级配置不会绕过工作区的数据治理策略。调用外部模型前，工作区仍需允许向外部服务发送数据。

## 生产部署

生产 Compose 与开发 Compose 完全独立，不共享容器项目名或数据卷。

### 1. 准备配置

```bash
cp .env.example .env
```

至少需要填写以下变量：

```dotenv
POSTGRES_PASSWORD=随机强密码
MIGRATOR_PASSWORD=迁移角色密码
API_PASSWORD=API角色密码
WORKER_PASSWORD=Worker角色密码

DATABASE_URL_MIGRATOR=postgres://ailearn_migrator:密码@postgres:5432/ailearn
DATABASE_URL_API=postgres://ailearn_api:密码@postgres:5432/ailearn
DATABASE_URL_WORKER=postgres://ailearn_worker:密码@postgres:5432/ailearn

AI_CREDENTIAL_ENCRYPTION_KEY=32字节随机密钥
OWNER_EMAIL=你的管理员邮箱
OWNER_PASSWORD=至少12位的管理员密码
```

可以使用下面的命令生成模型凭据加密密钥：

```bash
openssl rand -base64 32
```

如果数据库密码包含 `@`、`:`、`/` 或 `#` 等字符，写入连接 URL 前必须进行 URL 编码。`.env` 已被 Git 忽略，不要把真实密码或 Key 提交到仓库。

通过本机明文 HTTP 测试生产栈时，需要设置：

```dotenv
AUTH_COOKIE_SECURE=false
```

真实 HTTPS 部署必须保持 `AUTH_COOKIE_SECURE=true`。

### 2. 校验并启动

```bash
make config
make up
make seed-owner
```

生产环境使用三个独立数据库角色：

- `ailearn_migrator`：执行迁移
- `ailearn_api`：处理 API 请求
- `ailearn_worker`：处理后台任务

应用角色不具备 DDL 权限。生产容器以非 root 用户运行。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `make dev` | 启动开发环境 |
| `make seed-demo` | 创建本地演示账号 |
| `make logs` | 查看开发环境日志 |
| `make down-dev` | 停止开发环境并保留数据 |
| `make reset-dev` | 删除开发数据库卷并重新启动 |
| `make config` | 校验生产配置 |
| `make up` | 构建并启动生产环境 |
| `make seed-owner` | 创建生产 Owner 账号 |
| `make down-prod` | 停止生产环境并保留数据 |
| `make reset` | 删除生产数据库卷并重新启动 |
| `make storage-dev` | 启动开发环境及 MinIO |
| `make storage` | 启动生产环境及 MinIO |
| `make clean-init` | 等待并清除生产环境成功退出的初始化容器 |
| `make clean-init-dev` | 等待并清除开发环境成功退出的初始化容器 |

`reset` 和 `reset-dev` 会删除对应的数据卷，请先确认数据已经备份。

`up`、`dev`、`storage`、`storage-dev` 会在启动后自动等待并删除成功退出的一次性初始化容器（`migrate`、`role-bootstrap`、`role-grants`、`minio-init`），使其不会以 `Exited` 状态残留在 `docker ps -a` 中。初始化失败会让命令返回失败并保留容器，便于读取日志；`seed-*` 命令使用 `run --rm`，执行后容器自动删除。

## 测试

各模块使用独立 lockfile。干净检出时先安装共享包，再运行服务测试：

```bash
(cd packages/shared && npm ci && npm test && npm run typecheck)
(cd packages/db && npm ci && npm run typecheck)
(cd apps/api && npm ci && npm test && npm run typecheck)
(cd apps/web && npm ci && npm test && npm run typecheck)
(cd workers/ai-worker && npm ci && npm test && npm run typecheck)
```

GitHub Actions 还会执行：

- ESLint 和生产依赖安全审计
- 全新数据库迁移、重复迁移和旧版本升级迁移
- API、Web、Worker 生产构建
- 非 root Docker 镜像检查
- 完整生产 Compose 启动和服务健康检查
- Worker 实际任务消费
- PostgreSQL 备份与恢复演练

## 项目结构

```text
.
├── apps/
│   ├── api/                  # Fastify API、认证、业务模块和数据库迁移
│   └── web/                  # Next.js Web 应用
├── workers/
│   └── ai-worker/            # AI 生成、来源解析和后台任务
├── packages/
│   ├── db/                   # Worker 使用的数据库访问层
│   └── shared/               # 共享类型、Schema 和安全工具
├── infra/
│   ├── postgres/             # PostgreSQL 初始化、角色和授权脚本
│   └── minio/                # 可选对象存储说明
├── .github/workflows/        # CI 流水线
├── docker-compose.yml        # 生产环境
├── docker-compose.dev.yml    # 本机开发环境
├── .env.example              # 生产配置模板
└── Makefile                  # 常用运行命令
```

## 常见问题

### 无法登录

开发环境先执行 `make seed-demo`。生产环境需要在 `.env` 中填写 Owner 凭据，然后执行 `make seed-owner`。

### 模型测试返回 400

检查 Base URL 是否与服务商协议一致、模型 ID 是否正确、账号是否拥有模型权限，以及账户是否还有可用额度。DashScope 的新模型优先使用兼容模式地址。

### 模型测试返回 401 或 403

重新填写 API Key，并确认 Key 所属项目、区域和模型授权。系统不会从页面重新显示已经保存的完整 Key。

### 端口被占用

通过 `API_PORT`、`WEB_PORT` 修改映射端口。开发环境还会使用宿主机 `5432` 端口。

### 查看服务状态

```bash
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f api worker web
```
