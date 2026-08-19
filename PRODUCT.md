# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 15 + React 19 + TypeScript + Tailwind CSS（Web 前端）；Fastify 5 + Drizzle ORM + PostgreSQL 16（API）；Node.js + TypeScript（AI Worker）；Electron 37（桌面壳，加载 Web 应用）；Docker Compose（开发与部署）。编辑器使用 Milkdown，数学渲染使用 KaTeX，语音识别使用 sherpa-onnx。

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

**AI 模型配置：** 用户级模型配置，支持系统默认、阿里云百炼（DashScope）、OpenAI-compatible 三种模式。API Key 使用 AES-256-GCM 服务端加密保存，页面只显示末四位。支持连接测试。

**AI 伴星：** 包含 Live2D 角色驱动、精灵图回退、TTS 语音合成、ASR 本地语音识别（sherpa-onnx）、情绪表达（VAD 模型）、对话系统和学习动作引导。桌面端有独立桌宠窗口和托盘菜单。

**安全约束：** HttpOnly Cookie 认证、CSRF 防护、登录限流、最小权限数据库角色（migrator / api / worker 三角色分离）、CSP、SRI。生产容器以非 root 用户运行。

## Capabilities and Constraints

**已确认功能：**
- 文本、Markdown、代码和 URL 来源采集与解析
- 笔记编辑、自动保存和不可变版本记录
- AI 学习卡生成与证据对齐（V2 带候选审核和 Agent 活动流）
- 理解验证（三分钟微旅程，LearningRun 统一入口）
- 间隔复习计划和学习记录
- 全文搜索、来源追踪和理解关系图
- 工作区管理（个人 / 协作，Owner / Member 角色）
- 用户级 AI 模型配置与连接测试
- AI 伴星（测试中，持续迭代）：Live2D / 精灵图角色、语音对话、情绪表达、学习动作引导、桌宠窗口

**技术约束：**
- PostgreSQL 16 为唯一持久化存储
- 最小权限数据库角色分离（DDL / API / Worker）
- API Key 使用 AES-256-GCM 服务端加密
- Electron 桌面应用加载 Web 应用，不引入独立原生 UI
- CSP 严格化：script-src 保留 'unsafe-inline' + 'unsafe-eval'（Next.js 架构和 PIXI Live2D WebGL 着色器必需）

**Feature Flag 体系：** 多个构建期 feature flag 控制功能切流，fail-closed 设计——flag 关闭时回退安全路径。当前桌面打包启用全部 flag（伴星、学习卡 V2、Agent 活动流、语音入口、LearningRun、星图行动、Journey V2 等）。

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

- 完整可运行的 Web 应用（`apps/web`），含首页 Dashboard、笔记编辑器、学习卡、验证流程、复习页面、搜索、理解关系图
- 完整可运行的 API 服务（`apps/api`），Fastify 5 实现
- AI Worker 进程（`workers/ai-worker`），后台任务消费
- Electron 桌面应用（`apps/desktop`），含 Live2D 桌宠、ASR 语音、托盘菜单、自动更新
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
- `prefers-reduced-motion: reduce` 全站动画降级
- 移动端表单控件统一 16px 字号，防止 iOS Safari 聚焦缩放
- Playwright + @axe-core/a11y E2E 无障碍测试
- 触摸控件最小尺寸 44px（`--control-height-touch`）
- 成员只读模式：Member 界面明确标注权限边界，不伪装操作入口
