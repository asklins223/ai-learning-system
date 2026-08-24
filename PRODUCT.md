# Product

<!-- impeccable:product-schema 1 -->
<!-- q0-doc-metadata: status=CURRENT_PRODUCT_TRUTH; version=V1; date=2026-08-23; implementation-freeze=active -->

## Platform

adaptive（Electron desktop UI，覆盖 macOS / Windows / Linux）；不再提供浏览器端产品

## Stack

Electron 43 + electron-vite 5 + Vite 7 + React 19 + TypeScript（独立桌面客户端）；GSAP 动效编排 + Zustand（本地呈现状态）。V1 是高质量 2D 房间与真实 DOM 任务面，不建设场景级 3D/WebGL（3D 仅是 V2+ 独立研究方向）。Fastify 5 + Drizzle ORM + PostgreSQL 16 继续承担 API 与持久化，Node.js + TypeScript 继续承担 AI Worker。旧 Next.js Web 前端与“Electron 启动本机 Web 服务”的壳仅作为迁移参照，不再是目标运行时。

## Users

**主要用户：C 端个人学习者。** 面向需要系统化管理自主学习过程的个人用户——包括学生、研究者、知识工作者等任何需要把零散材料整理为可验证理解的人。

用户的核心任务是：从一份真正想弄懂的材料出发，逐步整理成可以验证的理解，并通过间隔复习巩固。

工作区支持两种模式：
- **个人工作区**（Personal）：创建者即所有者，拥有全部读写权限。
- **协作工作区**：Owner 拥有增删改权限；Member 只读工作区数据，但可进行验证、复习和查看理解状态等用户私有操作。

## Product Purpose

理解引擎是一个面向个人学习的 AI 原生知识系统。它把资料采集、笔记编辑、AI 学习卡生成、证据对齐、理解验证和间隔复习连接成一条可追溯的学习闭环，让学习者始终知道"自己理解了什么、还缺什么、下一步该做什么"。

产品存在的意义：解决个人学习中"学了但不知道是否真的懂了"的问题——不只是存储知识，而是让每一条理解都有证据支撑、可验证、可追溯、可复习。

成功意味着：用户能走完一条完整的学习闭环（材料 → 笔记 → 学习卡 → 证据对齐 → 验证 → 复习），并在闭环中逐步建立对自己理解质量的信心。

## Positioning

理解引擎不是单纯的知识管理工具（如 Notion / Obsidian），也不是单纯的记忆卡工具（如 Anki），而是把"材料 → 笔记 → 学习卡 → 证据对齐 → 验证 → 复习"连接成一条**可追溯学习闭环**的 AI 原生系统。每一条理解都有来源、有证据、有验证记录、有复习节奏——这是任何单一工具无法独立提供的。

正在打磨的第二差异化：**AI 伴星（Companion）**——一个持续陪伴学习过程的 AI 角色，具备 Live2D 形象、语音对话和学习引导能力，目标是让学习不再是孤独的单向消费，而是一场有伙伴的对话式探索。

## Operating Context

**学习闭环工作流：**
1. **采集来源**：粘贴文本、Markdown、代码或 URL，系统解析为结构化来源
2. **笔记编辑**：基于来源撰写笔记，Milkdown 编辑器支持 Markdown + 数学公式，自动保存和不可变版本记录
3. **AI 学习卡生成**：从笔记中生成带证据对齐的学习卡
4. **理解验证**：三分钟微旅程验证，检验是否真正理解
5. **间隔复习**：基于验证结果安排复习计划，到期提醒
6. **理解关系图**：可视化知识结构与理解状态

**AI 使用与数据边界：** 当前设置页的 AI 区块只提供工作区级 **AI 使用同意与数据外发政策**（Owner 签署，`/workspace/ai-consent`）。仓库中没有用户级模型/供应商选择或 BYOK UI；此类能力属于未来产品决定，在落地前不得写成现有功能。

**AI 伴星：** 全应用内持续存在的单一身份 Companion。V1 默认呈现为低干扰 orb；窗口内 Live2D 需用户显式选择并通过许可/打包 Gate 后才可用，正式测评中 fail-closed 静默。旧 Electron 应用（`apps/desktop`）的独立桌宠窗口、托盘与 ASR 仅作为待迁移能力参照保留；新客户端 V1 不做窗口外透明桌宠。服务端已具备 Live2D 角色驱动、精灵图回退、TTS、ASR（sherpa-onnx）、情绪表达与对话系统能力，按合同逐步接入桌面端。

**安全约束：** 服务端继续保持登录限流与最小权限数据库角色（migrator / api / worker 三角色分离）；新桌面客户端使用受控本地协议、严格 CSP、`contextIsolation`、渲染进程沙箱和窄 preload IPC。后续认证通过主进程的类型化 API 网关接入，凭据不得暴露给渲染进程。

## Capabilities and Constraints

**已确认功能：**
- 文本、Markdown、代码和 URL 来源采集与解析
- 笔记编辑、自动保存和不可变版本记录
- AI 学习卡生成与证据对齐（V2 带候选审核和 Agent 活动流）
- 理解验证（三分钟微旅程，LearningRun 统一入口）
- 间隔复习计划和学习记录
- 全文搜索、来源追踪和理解关系图
- 工作区管理（个人 / 协作，Owner / Member 角色）
- 工作区 AI 使用同意与数据外发政策设置（无模型/供应商配置）
- AI 伴星（测试中，持续迭代）：应用内 orb 为默认呈现；Live2D / 语音 / 情绪表达按合同逐步接入，桌宠窗口仅存于旧客户端参照

**技术约束：**
- PostgreSQL 16 为唯一持久化存储
- 最小权限数据库角色分离（DDL / API / Worker）
- API Key 使用 AES-256-GCM 服务端加密
- 桌面客户端从 `apps/desktop-client` 独立构建，不启动 Next.js、本机 HTTP 服务或端口扫描
- 主界面采用“高质量 2D 房间 + 可访问 DOM 任务面”；固定镜头而非自由漫游，最低窗口尺寸为 1024×700；不建设场景级 3D/WebGL
- 渲染进程无 Node.js 权限；所有系统能力必须经来源校验后的窄 IPC 暴露
- 媒体是渐进增强：视频/声音失败或 `prefers-reduced-motion` 时回退到同构图 poster 与完整 DOM 操作，静态 poster 是正式稳定状态；重型研究册模型（V2+ 3D 研究资产）不得进入首包
- 当前学习房间素材仍标记 `reviewOnly / IN_REVIEW`，授权与发布验收完成前不得作为生产素材宣称

**Feature Flag 体系：** 服务端既有 feature flag 与 fail-closed 合同继续保留；新桌面客户端按领域逐步接入，不默认继承旧 Web 构建时 flag，也不在尚未连通的场景中伪造领域结果。

**未决定/进行中：**
- AI 伴星目前处于测试阶段，持续迭代中，后续将成为核心产品体验组成部分，但具体功能形态仍在打磨
- 工作区协作的成员权限粒度可能进一步细化

## Brand Commitments

- **产品名**：理解引擎（英文：ailearn / AI Learning System）
- **品牌标识**："理解引擎" + 橙色圆点，使用衬线体（Noto Serif SC / Songti SC）
- **语言**：界面语言为简体中文（`lang="zh-CN"`）
- **视觉身份**：温暖纸感学习桌面——暖米色调、纸纤维纹理、物理阴影卡片、衬线+楷体混合字体系统、暖棕暗色模式。不使用冷灰蓝 SaaS 审美。
- **开源**：MIT License

## Evidence on Hand

- 新桌面客户端（`apps/desktop-client`）已有可运行的第一套理解书房场景：房间总览、固定镜头聚焦、继续学习、研究册本机草稿、复习与搜索演示面、静态回退
- 旧 Web 应用（`apps/web`）保留为迁移期间的领域行为参照，不再作为目标前端或桌面运行依赖
- 完整可运行的 API 服务（`apps/api`），Fastify 5 实现
- AI Worker 进程（`workers/ai-worker`），后台任务消费
- 旧 Electron 应用（`apps/desktop`）保留桌宠、ASR、托盘与更新能力作为待迁移参照；新客户端达到能力等价后再安全退役
- 完整设计 Token 体系（`apps/web/app/styles/tokens.css`），含日间/夜间双主题
- 深色模式和浅色模式界面截图（`docs/image/`）
- Docker Compose 开发环境（`docker-compose.dev.yml`）和生产配置（`docker-compose.yml`）
- CI 流水线（`.github/workflows/ci.yml`），含 ESLint、安全审计、迁移测试、生产构建、镜像扫描、服务健康检查
- Playwright E2E 测试和 Vitest 单元测试

## Product Principles

1. **闭环优先**：产品的核心价值不在任何单一功能，而在"材料 → 笔记 → 卡 → 验证 → 复习"这条闭环的完整性和可追溯性。任何功能设计不得断裂闭环。

2. **理解可验证**：学习不是消费内容，而是建立可验证的理解。每一条理解都应有来源、有证据、可被检验——"我是否真的懂了"比"我看过了"更重要。

3. **伴星陪伴学习**：学习不应是孤独的单向消费。AI 伴星是产品差异化的重要组成部分，持续打磨为一个有温度的、能对话、能引导、能陪伴的学习伙伴。

4. **温暖而非冷感**：视觉和交互设计刻意远离冷灰蓝 SaaS 审美，用暖纸面和物理质感让学习者感觉坐在一张真实的书桌前——这是产品身份的一部分，不可妥协。

5. **渐进增强，安全兜底**：功能通过 feature flag 渐进切流，fail-closed 设计确保关闭时回退安全路径。安全约束（最小权限、加密、CSP）是底线，不为功能便利让步。

## Accessibility & Inclusion

- 跳转链接（skip-link）已实现，键盘焦点环（`:focus-visible`）全站覆盖
- `prefers-reduced-motion: reduce` 将镜头与界面动画降级为即时状态切换，`Esc` 可结束镜头运动
- Canvas 不承担标题、状态、编辑器和主操作的无障碍语义；热点与任务操作均使用真实 DOM 控件
- 桌面键盘快捷键覆盖继续学习、复习和全局搜索；最低支持 1024×700 窗口
- 成员只读模式：Member 界面明确标注权限边界，不伪装操作入口
