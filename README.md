<div align="center">

# 理解引擎

[![Version](https://img.shields.io/badge/version-v0.5.0-blue.svg)](https://github.com/asklins223/ai-learning-system)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

理解引擎 是一个面向个人学习的 AI 原生知识系统。它把资料、笔记、学习卡、证据引用、理解验证和复习计划连接成一条可追溯的学习闭环。

## 界面预览

### 深色模式

![深色模式界面](/docs/image/Snipaste_2026-07-18_20-04-12.png)

### 浅色模式

![浅色模式界面](/docs/image/Snipaste_2026-07-18_20-04-30.png)

## 核心能力

- 文本、Markdown、代码和 URL 来源采集与解析
- 笔记编辑、自动保存和不可变版本记录
- AI 学习卡生成与证据对齐
- 理解验证、复习计划和学习记录
- 全文搜索、来源追踪和理解关系图
- 工作区级 AI 使用同意与数据外发策略
- HttpOnly Cookie、CSRF、登录限流和最小权限数据库角色

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 桌面客户端 | Electron 43、Vite 7、React 19、TypeScript |
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
make up
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

### 3. 启动桌面客户端

```bash
make desktop-client-dev
```

API 检查地址：

- `http://localhost:4000/health`：存活检查
- `http://localhost:4000/ready`：就绪检查

## AI 数据治理

外部模型调用由 Worker 的平台配置与工作区同意策略共同控制。调用学习内容前，工作区必须明确允许数据外发；桌面客户端不提供个人模型或供应商配置界面。

## 生产部署

`docker-compose.yml` 是生产配置，仅供 CI 构建和扫描生产镜像使用，不再绑定任何本地 Makefile 目标。本机开发统一使用 `docker-compose.dev.yml`（`make up`），自带源码挂载和热重载。

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

### 2. 构建与发布

生产镜像由 CI 流水线（`.github/workflows/ci.yml`）从 `docker-compose.yml` 构建，并通过 Trivy 漏洞扫描门禁。本地如需手动验证生产镜像，可直接使用 docker compose：

```bash
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml build api worker
```

生产环境使用三个独立数据库角色：

- `ailearn_migrator`：执行迁移
- `ailearn_api`：处理 API 请求
- `ailearn_worker`：处理后台任务

应用角色不具备 DDL 权限。生产容器以非 root 用户运行。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `make up` | 启动开发环境（源码挂载、热重载） |
| `make seed-demo` | 创建本地演示账号 |
| `make logs` | 查看日志 |
| `make down` | 停止并保留数据 |
| `make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB` | 明确确认后删除开发数据库卷并重新启动 |
| `make rebuild` | 无缓存重新构建开发镜像 |
| `make config` | 校验开发配置 |
| `make storage` | 启动开发环境及 MinIO |
| `make clean-init` | 清除已退出的初始化容器 |
| `make shell-api` | 进入 API 容器 shell |
| `make shell-worker` | 进入 Worker 容器 shell |
| `make desktop-client-dev` | 启动桌面客户端开发模式 |
| `make desktop-client-dist` | 构建桌面客户端安装包 |

开发数据库使用固定 external 卷 `ailearn-dev_dev_postgres_data`。`make up` 会在首次启动时自动创建该卷；`make down`、删除容器以及 `docker compose down -v` 都不会删除它。确实需要清空数据库时，先完成备份，再使用表格中的带确认值命令。

`up`、`storage` 会在启动前清除上一轮的一次性初始化容器，并在启动后等待本轮 `role-bootstrap`、`migrate`（以及存储模式下的 `minio-init`）执行完毕。本轮容器会以 `Exited` 状态保留，便于 Docker Desktop 的整组 Start 重新执行初始化；下次启动时再清除。`seed-demo` 使用 `run --rm`，执行后容器自动删除。

## 测试

各模块使用独立 lockfile。干净检出时先安装共享包，再运行服务测试：

```bash
(cd packages/shared && npm ci && npm test && npm run typecheck)
(cd apps/api && npm ci && npm test && npm run typecheck)
(cd workers/ai-worker && npm ci && npm test && npm run typecheck)
(cd apps/desktop-client && npm ci && npm test && npm run typecheck)
```

GitHub Actions 还会执行：

- ESLint 和生产依赖安全审计
- 全新数据库迁移、重复迁移和旧版本升级迁移
- API、Worker 生产构建；桌面客户端独立构建
- 非 root Docker 镜像检查
- 完整生产 Compose 启动和 API/Worker 健康检查
- Worker 实际任务消费
- PostgreSQL 备份与恢复演练

## 项目结构

```text
.
├── apps/
│   ├── api/                  # Fastify API、认证、业务模块和数据库迁移
│   └── desktop-client/       # Electron 桌面客户端
├── workers/
│   └── ai-worker/            # AI 生成、来源解析和后台任务
├── packages/
│   ├── db/                   # Worker 使用的数据库访问层
│   └── shared/               # 共享类型、Schema 和安全工具
├── infra/
│   ├── postgres/             # PostgreSQL 初始化、角色和授权脚本
│   └── minio/                # 可选对象存储说明
├── .github/workflows/        # CI 流水线
├── docker-compose.yml        # CI 生产镜像构建配置
├── docker-compose.dev.yml    # 本机开发环境（默认）
├── .env.example              # 生产配置模板
└── Makefile                  # 常用运行命令
```

## 常见问题

### 无法登录

开发环境先执行 `make seed-demo` 创建演示账号。生产环境的 Owner 账号由 CI 发布流程处理。

### 模型测试返回 400

检查 Base URL 是否与服务商协议一致、模型 ID 是否正确、账号是否拥有模型权限，以及账户是否还有可用额度。DashScope 的新模型优先使用兼容模式地址。

### 模型测试返回 401 或 403

重新填写 API Key，并确认 Key 所属项目、区域和模型授权。系统不会从页面重新显示已经保存的完整 Key。

### 端口被占用

通过 `API_PORT` 修改 API 映射端口。开发环境还会使用宿主机 `5432` 端口。

### 查看服务状态

```bash
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f api worker
```
