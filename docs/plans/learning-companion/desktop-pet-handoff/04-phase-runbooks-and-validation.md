# 04 — P0–P6 分阶段运行手册与验证 Gate

> 状态：执行中；P1 Surface V2.3 回归已记录，后续阶段仍按 Owner Gate
>
> 适用阶段：P0–P6
>
> 目标：让陌生实施 Agent 能按同一顺序、同一范围和同一证据标准交付；禁止用宿主机单测、浏览器截图或文件存在替代真实桌面与容器验证

---

## 1. 执行规则

### 1.1 一个任务只实施一个阶段

实施 Agent 每次只能执行 `README.md` Owner 批准记录中的一个阶段。阶段状态只有：

```text
not_approved → approved → in_progress → gate_passed
                                  └──→ blocked
                                  └──→ changes_requested
```

- `gate_passed` 只说明当前阶段通过，不自动授权下一阶段；
- `blocked` 必须保留已产生的安全变更与证据，不得用 mock 绕过；
- P1 是 Surface Prototype，P3 才是 Usable Desktop Pet V1；
- P6 通过前，不得宣称 Release Candidate；
- 每阶段结束必须停止并等待 Owner 审阅。

### 1.2 权威合同

每次开工必须完整阅读：

1. [`README.md`](./README.md)；
2. [`01-product-ux-character-contract.md`](./01-product-ux-character-contract.md)；
3. [`02-runtime-window-state-contract.md`](./02-runtime-window-state-contract.md)；
4. [`03-conversation-api-data-proactive-contract.md`](./03-conversation-api-data-proactive-contract.md)；
5. 本运行手册；
6. 总方案 [`../13-desktop-pet-ai-learning-companion-reconstruction.md`](../13-desktop-pet-ai-learning-companion-reconstruction.md)。

发现文档与当前工程安全不变量冲突时先更新方案并请求 Owner 决策，不允许在代码中悄悄选择一种解释。

### 1.3 工作区安全

- 当前工作区可能包含 Owner 未提交变更；开工先执行 `git status --short` 和 `git diff --name-only`；
- 禁止 `git reset --hard`、`git checkout -- <path>`、覆盖式复制和批量删除；
- 只修改本阶段“允许范围”中的文件；范围外确需改动时先报告理由与影响；
- 不打印 `.env`、provider key、cookie、转写原文或原始音频；
- 不用重建数据库证明迁移可用；开发数据库只能通过仓库已有的显式确认命令删除；
- 新依赖必须在阶段报告中记录版本、锁文件、许可证、打包体积、native binary 和替代方案。

---

## 2. 通用开工检查

### 2.1 开工记录

每阶段第一条实施记录必须包含：

```text
批准阶段：P?
Owner 批准记录：<文件与字段>
上一阶段证据：<绝对路径 / 不适用>
HEAD：<完整 commit>
脏工作区：<重叠文件和处理方式>
外部 Gate：<资产 / 许可 / 凭据 / 平台>
允许修改：<明确文件或目录>
禁止修改：<明确文件或目录>
验证环境：<macOS / CPU 架构 / Electron / Node / Docker>
```

### 2.2 不泄密的预检命令

从仓库根目录运行：

```bash
git rev-parse HEAD
git status --short
node --version
npm --version
docker version
docker compose version
make config
```

`make config` 是 `.env` 可解析性的硬 Gate。当前 `docker-compose.dev.yml` 强制要求 `EDGE_TTS_AUTH_TOKEN`；缺失时必须提示 Owner 按 `.env.example` 配置，不能输出或代填 token，也不能通过删除 compose 校验绕过。

随后记录基线：

```bash
make version-check
make desktop-build
```

如果基线因本阶段开始前已有问题失败，先保存原始输出并判断是否与本阶段重叠。不可把基线红灯归因于本次实现，也不可在未授权范围内顺手修复。

### 2.3 Docker 启动与日志硬 Gate

涉及 Web、API、Worker、数据库或语音的阶段必须运行当前开发栈：

```bash
make up
docker compose -p ailearn-dev -f docker-compose.dev.yml ps --all
docker compose -p ailearn-dev -f docker-compose.dev.yml logs --no-color --since=15m web api worker edge-tts
```

验证的是 Compose service 和它实际解析出的容器，不依赖某一台机器固定的数字后缀。证据中必须同时保存 `ps --all`，并确认其中的 Web 容器（通常为 `ailearn-dev-web-1`）。

只在宿主机执行 `npm run build` 不足以通过 Gate。所有影响 Web 模块解析、路由、环境变量或 Docker mount 的阶段还必须运行：

```bash
docker compose -p ailearn-dev -f docker-compose.dev.yml run --rm --no-deps web npm run typecheck
docker compose -p ailearn-dev -f docker-compose.dev.yml run --rm --no-deps -e NODE_ENV=production web npm run build
docker compose -p ailearn-dev -f docker-compose.dev.yml logs --no-color --since=15m web api worker edge-tts
```

开发 compose 会为常驻 dev server 注入非 production `NODE_ENV`；临时执行 `next build` 时必须按上式显式覆盖为 `production`。否则 Next 的预渲染行为与发布构建不一致，不能把该环境失败当作产品构建结论。

日志 Gate 失败条件：

- `Module not found`、`Can't resolve`、`Build Error` 或 Next.js error overlay；
- API/Worker 未捕获异常、持续重启或 migration/RLS 错误；
- Pet renderer 白屏、preload 加载失败、IPC sender 校验失败；
- Electron main 的窗口、Web server 或资源释放异常；
- edge-tts 鉴权或健康检查失败且该阶段依赖语音；
- 任何未解释的新 error。已知无关基线问题必须附原始日志、首次出现时间和 Owner 接受记录，不能直接忽略。

### 2.4 通用代码 Gate

按改动范围执行最小测试，阶段结束再执行全量基线：

```bash
(cd packages/shared && npm run typecheck && npm test)
(cd packages/db && npm run typecheck && npm test)
(cd apps/api && npm run typecheck && npm test && npm run build)
(cd workers/ai-worker && npm run typecheck && npm test && npm run build)
(cd apps/web && npm run typecheck && npm run lint && npm test && npm run build)
(cd apps/desktop && npm run typecheck && npm test && npm run build)
(cd tests/e2e && npm run typecheck)
make verify
```

以上 subshell 命令均从仓库根目录执行。纯 P0/P1 且没有改 API/DB/Worker 时可省略未触及包的重复局部命令，但阶段最终仍必须运行 `make verify`；若环境使其无法运行，阶段只能标为 `blocked`，不能标为通过。

---

## 3. 证据目录与阶段报告

### 3.1 固定结构

每阶段创建独立证据目录：

```text
docs/evidence/learning-companion-desktop-pet/
  P0/<YYYYMMDD-HHMMSS>/
  P1/<YYYYMMDD-HHMMSS>/
  ...
  P6/<YYYYMMDD-HHMMSS>/
```

每个目录至少包含：

```text
phase-report.md
environment.txt
changed-files.txt
commands.log
test-summary.md
docker-ps.txt
docker-logs.txt
electron-main.log
renderer-console.log
known-issues.md
```

涉及视觉/交互时再包含：

```text
screenshots/
recordings/
performance/
accessibility/
```

不得把 secret、session cookie、完整私人对话、原始录音或带私人桌面内容的未裁剪录屏提交到 Git。必要证据先脱敏。

### 3.2 `phase-report.md` 模板

```yaml
phase: P?
result: gate_passed | blocked | changes_requested
headBefore: "<sha>"
headAfter: "<sha>"
ownerApproval: "<README section / approval note>"
previousEvidence: "<path or n/a>"
implementedScope: []
deferredScope: []
changedFiles: []
newDependencies: []
migrations: []
featureFlags: []
testsPassed: []
testsFailed: []
dockerServicesChecked: [web, api, worker, edge-tts]
unexplainedErrors: []
rollbackVerified: false
ownerReviewRequired: []
```

报告正文必须区分：已自动验证、已人工验证、未验证、被 Gate 阻塞。禁止使用“应该可以”“基本完成”“代码已存在”等完成表述。

### 3.3 阶段关闭顺序

1. 冻结修改范围；
2. 运行局部测试；
3. 运行 Docker Web build 与服务日志检查；
4. 运行真实 Electron 场景；
5. 运行 `make verify`；
6. 做回滚/开关验证；
7. 填写阶段报告与已知问题；
8. 将阶段标为 `gate_passed` 或 `blocked`；
9. 停止，不进入下一阶段。

---

## 4. P0 — Desktop Window Technical Spike

### 4.1 目标和非目标

目标：证明当前 Electron 壳能安全承载同源、透明、无边框、可穿透、可恢复位置的 Pet Window。

P0 不做真实对话、数据库、AI provider、生产角色、语音或学习动作。测试 PNG/几何块必须带显眼 `P0 SPIKE` 标记，不能流入 P1。

### 4.2 输入 Gate

- Owner 批准记录只需包含 `P0`；
- 有可运行的 macOS 真机环境；
- P0 基线固定使用当前锁文件中的 Electron `33.4.1`；只记录升级评估，不在 P0 升级；若当前版本无法满足硬 Gate，必须提交独立升级提案并等待 Owner 批准；
- 技术 spike 可使用仓库内自制测试图形，不需要角色资产许可；
- 不自动追 Electron 最新版本。

### 4.3 允许范围

优先使用以下结构：

```text
apps/desktop/src/main.ts
apps/desktop/src/windows/main-window.ts
apps/desktop/src/windows/pet-window.ts
apps/desktop/src/windows/pet-window-contract.ts
apps/desktop/src/windows/pet-window-state.ts
apps/desktop/src/windows/pet-hit-test-controller.ts
apps/desktop/src/ipc/register-pet-ipc.ts
apps/desktop/src/ipc/validate-sender.ts
apps/desktop/src/preload/main-preload.ts
apps/desktop/src/preload/pet-preload.ts
apps/desktop/src/persistence/device-pet-preferences.ts
apps/desktop/esbuild.mjs
apps/desktop/package.json
apps/web/app/(pet)/companion/pet/page.tsx
apps/web/app/(pet)/companion/pet/layout.tsx
apps/web/package.json
packages/shared/src/desktop-pet-contracts.ts
packages/shared/src/index.ts
packages/shared/src/feature-flags.ts
packages/shared/src/feature-flags.test.ts
apps/web/lib/feature-flags.ts
apps/web/lib/__tests__/feature-flags.test.ts
```

若保留现有 `apps/desktop/src/preload.ts`，必须明确它对应哪个窗口且实际配置到 `webPreferences.preload`。P0 禁止修改数据库 migration、对话 API、Worker handler、角色生产资产和旧 Companion UI 行为。

### 4.4 固定实施顺序

1. 抽出 Main Window 创建函数，但保持现有启动、错误处理和关闭语义可回滚；
2. 接入 context-isolated preload，建立 sender/origin 校验；
3. 创建 `/companion/pet` 最小路由，确认不经过 workspace `AppShell`；
4. 创建 Pet Window，并使用 `showInactive()` 验证不抢焦点；
5. 验证 Main/Pet 同一 origin、默认 session partition 和登录 cookie；
6. 实现主进程命中几何协议，不向 renderer 暴露任意 `setIgnoreMouseEvents`；
7. 验证透明区域穿透、交互区点击和拖动互斥；
8. 实现显示器指纹、位置 clamp 和 reset；
9. 验证 Main Window 隐藏/关闭策略下 Pet 存活，显式 Quit 才释放全部资源；
10. 记录多屏、Retina、全屏 Space、休眠/唤醒和系统锁屏表现；
11. 关闭 P0 flag，验证恢复现有单窗口行为。

P0 必须给 `apps/desktop/package.json` 新增可重复的 `npm test` script，并确保纯逻辑测试不依赖已启动 Electron；现有 Web `npm test` 必须扩展为实际发现 `features/**/*.test.ts(x)`，不能让新 reducer/route 测试成为未执行文件。

### 4.5 自动测试

至少新增：

- `apps/desktop/src/windows/pet-window-contract.test.ts`：window option contract；
- `apps/desktop/src/ipc/register-pet-ipc.test.ts`：IPC schema 与非法 sender 拒绝；
- navigation/window-open/permission policy：动态 `127.0.0.1:<port>` 精确 origin，Pet 任意跳转、非 HTTPS 外链和默认 permission 均拒绝；
- `apps/desktop/src/windows/pet-hit-test-controller.test.ts`：hit-mask/polygon 边界和最大尺寸；`getCursorScreenPoint/getContentBounds` 按 DIP 直接相减，Retina/缩放下不得重复乘除 scaleFactor；
- `apps/desktop/src/persistence/device-pet-preferences.test.ts`：position clamp、多屏移除、DPI 变化、privacy 默认关闭及损坏文件回退；
- Desktop lifecycle 资源清理，以及 Main close→hide、Dock activate/second-instance 恢复、退出桌宠模式和 Cmd+Q 真退出测试；
- Web 结构测试：`/companion/pet` route 不导入 `AppShell`/旧 `CompanionRuntimeProvider`。

运行：

```bash
(cd apps/desktop && npm run typecheck && npm test && npm run build)
(cd apps/web && npm run typecheck && npm run lint && npm test && npm run build)
docker compose -p ailearn-dev -f docker-compose.dev.yml run --rm --no-deps web npm run build
make verify
```

### 4.6 真机证据

- 30–60 秒录屏：透明区域点击下层原生应用；角色测试区仍可点击；
- 录屏：Pet 唤醒 Main、Main 隐藏后 Pet 存活、显式 Quit 后 Pet 消失；
- 录屏：暂时隐藏先提供 Main 恢复入口，退出桌宠模式后 Main 保持可用；
- 截图：双屏边缘、Retina 缩放、全屏 Space；
- 登录前/登录后截图；401 时 Pet 不泄漏私人内容；
- Electron main 与 renderer 日志；
- idle 5 分钟 CPU、内存、GPU 基线；
- 窗口配置快照和当前 Electron 版本。

### 4.7 P0 通过条件

`02-runtime-window-state-contract.md` §5–§10 的 P0 条件全部可复现；没有 native global hook；没有未解释日志错误；flag off 回滚成功。通过后停止，Owner 审阅证据再决定 P1。

---

## 5. P1 — Surface Prototype

### 5.1 目标和非目标

目标：交付 Owner 指定角色的真透明 Sprite、微型气泡、composer、二级菜单和浏览器 fallback 的正确外形。

P1 只使用确定性 fixture 文本演示状态，不连接 LLM、不写 conversation 数据、不调用 ASR/TTS。UI 必须显示开发标签 `Surface Prototype`，发布构建中该 fixture 路径 fail-closed。

### 5.2 输入 Gate

- P0 `gate_passed` 证据已获 Owner 接受；
- Owner 批准 `P1`；
- `01-product-ux-character-contract.md` 的 Level A 真透明资产包、hash 与权属记录已通过；
- P1 visual approval YAML 的可实现项已冻结；
- 缺少合规角色资产时 P1 必须 `blocked`，不得生成另一形象替代。

### 5.3 允许范围

```text
apps/web/app/(pet)/companion/pet/**
apps/web/features/companion-pet/runtime/**
apps/web/features/companion-pet/surfaces/**
apps/web/features/companion-pet/character/**
apps/web/features/companion-pet/desktop/**
apps/web/features/companion-pet/web-fallback/**
apps/web/app/styles/tokens.css
apps/web/public/images/companion/pet/sprite-v1/**
apps/web/package.json
apps/desktop/src/windows/pet-*
apps/desktop/src/ipc/register-pet-ipc.ts
apps/desktop/src/persistence/device-pet-preferences.ts
packages/shared/src/companion-character-contracts.ts
packages/shared/src/desktop-pet-contracts.ts
packages/shared/src/index.ts
packages/shared/src/feature-flags.ts
packages/shared/src/feature-flags.test.ts
apps/web/lib/feature-flags.ts
apps/web/lib/__tests__/feature-flags.test.ts
apps/desktop/package.json
docker-compose.dev.yml
docker-compose.yml
.env.example
```

只允许追加必要 token，不允许重定义全站既有语义 token。旧 `apps/web/features/companion/**` 保留，不在 P1 删除。

### 5.4 固定实施顺序

1. 对资产 manifest、尺寸、alpha 和许可证元数据做 fail-closed validator；
2. 实现 Sprite Driver 与八姿态映射；
3. 实现七域 reducer 的 P1 子集，Character 只消费派生 presentation；
4. 按合同坐标实现 PetSurface、Bubble、Composer、Menu；
5. 接主进程 hit geometry、角色本体直接拖动、辅助 drag handle、点击/长按手势仲裁和窗口边界；
6. 实现固定菜单顺序；P2/P3/P5 项显示禁用状态，不伪装可用；
7. “完整对话”只打开明确标记的占位页；
8. 实现 reduced motion、键盘、焦点、读屏标签、Electron 1×/2× DPI，以及 browser fallback 200% page zoom；
9. 实现同一 surface 的浏览器 fallback；
10. 逐项采集 G01–G12 金标准证据；
11. 关闭 P1 flag，验证旧 surface 可回滚。

### 5.5 自动测试

- manifest/LICENSE/hash/alpha validator，以及八姿态各自 hit-mask 与 pose revision；
- reducer 转移与 generation guard 基础；
- bubble 分段、TTL、边界翻转；
- 菜单顺序、禁用项、Esc 与键盘循环；
- 手动 privacy 开关设备本地持久化，且 fixture proactive 正文/自动播报抑制不影响主动 composer；
- hit geometry 与 DOM 可交互区域一致；
- 角色本体 click 与 direct-drag 的 `8 CSS px` 阈值、拖动后 click 抑制、右键/`500ms` 长按、pointercancel 和 `locked=true` 分支；
- reduced motion 不启动循环动画；
- Pet route 和浏览器 fallback smoke tests。
- browser fallback 在 `600×560` 阈值两侧、200% zoom、visualViewport resize 与底部导航避让测试；透明 root 不截获页面点击；

运行 Web/Desktop 通用 Gate，并执行容器 Web build。

### 5.6 视觉与交互证据

严格提交 `01-product-ux-character-contract.md` G01–G12 的 1×/2×截图和指定录屏；另外包含：

- 浅色/深色真实桌面背景，无棋盘烘焙背景；
- 四边和四角的气泡/menu clamp；
- 角色左右翻转但文字不镜像；
- 录屏证明角色本体可直接拖动且松手后不会误开 composer；短按仍只打开 composer，锁定后可点击但不可拖动；
- composer 输入法、键盘、Electron 1×/2× DPI，以及 browser fallback 200% page zoom；
- reduced motion；
- 浏览器 fallback 不遮挡导航和主操作；
- `ailearn-dev-web-1` 对应 Web service 日志无 import/build/runtime error。

### 5.7 P1 通过条件

自动 Gate 全绿且 Owner 在 visual approval YAML 中明确批准。报告名称必须是 `Surface Prototype`，不得写“AI 桌宠已完成”。随后停止。

### 5.8 Surface V2 回归记录（2026-08-11）

- 实施报告：[`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2/phase-report.md`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2/phase-report.md)；
- 机器可读 Electron 断言：[`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2/interaction-report.json`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2/interaction-report.json)；
- 交互结果：角色短按、直接拖动、拖后 click 抑制、typed bridge、locked 拖动、locked 短按和右键菜单共 9/9 通过；
- 自动结果：Web 默认测试 817/817、角色子系统 54/54、Desktop 14/14；Host/Docker production build 通过；
- 阶段声明仍为 `Surface Prototype`；P2 真实文字、P3 语音、P5 学习动作未由本记录自动升级为完成。

### 5.9 Surface V2.1 视觉、语音表面与拖动回归（2026-08-11）

- 实施报告：[`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-1/phase-report.md`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-1/phase-report.md)；
- 机器可读 Electron 断言：[`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-1/interaction-report.json`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-1/interaction-report.json)；
- 视觉结果：Surface 全部移除灰黑投影和 backdrop 暗底；外置麦克风不覆盖 composer；二级菜单焦点/选中描边四边完整；listening、transcribing 和 transcript review 有独立可辨识状态；
- 交互结果：真实 Electron 14/14 通过；本体拖动释放后的稳定位置与结束位置完全相同，回弹为 `0 DIP`；点按麦克风开始、再次点按结束并回填可编辑 transcript；
- 自动结果：Web 默认测试 833/833、本轮 reducer / drag transport 聚焦测试 27/27、Desktop 14/14；Web lint 零 warning；Web/Desktop typecheck 与 production build 均通过；
- 阶段声明仍为 `Surface Prototype / P1 Fixture`；真实 ASR、TTS、AI 对话与 P5 学习动作不在本次通过范围内。

### 5.10 Surface V2.3 流体语音岛回归（2026-08-11）

- 实施报告：[`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/phase-report.md`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/phase-report.md)；
- 机器可读 Electron 断言：[`../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/interaction-report.json`](../../../evidence/learning-companion-desktop-pet/P1/20260811-surface-v2-3/interaction-report.json)；
- 视觉结果：活动录音/识别不再占用对话气泡，不出现大语音卡、柱状/图表波形、“声音转文字”流程图或灰黑投影；角色侧只展开 `178×58` 流体语音岛；
- 动画结果：listening 使用旋转彩色色场 + 呼吸声纹；finalizing/transcribing 在同一流体核心内收束为识别脉冲；speaking 反向流动；`data-motion=reduced` 与系统 reduced-motion 均停用循环动画；
- 叠层结果：活动语音时 quick toolbar 与辅助 drag handle 自动收起，角色本体点击和直接拖动不失效；
- 交互结果：真实 Electron 14/14 通过；第一次点按开始、第二次点按结束并识别、transcript 回填可编辑 composer；拖动释放回弹为 `0 DIP`；
- 自动结果：Web 默认测试 842/842、reducer / gesture / drag transport / voice visualizer 聚焦测试 33/33、Desktop 14/14；Web lint 零 warning；Web/Desktop typecheck 与 production build 均通过；
- 阶段声明仍为 `Surface Prototype / P1 Fixture`；真实麦克风采集、ASR、TTS、AI 对话与 P5 学习动作不在本次通过范围内。

---

## 6. P2 — Durable Text Conversation

### 6.1 目标和非目标

目标：气泡完成真实、可取消、可断线恢复的 AI 文字回合，Main Window 提供完整历史；接入受约束的主动消息 inbox。

P2 不做麦克风/TTS、Live2D、canonical 学习动作、二进制附件、全局检索或移动端 surface。菜单中未到阶段的入口保持禁用或明确“尚未启用”。

### 6.2 输入 Gate

- P1 视觉证据已由 Owner 批准；
- Owner 批准 `P2`；
- Docker Postgres/API/Worker/Web 可运行；
- 至少一个 `AI_PLATFORMS_CONFIG` 中受支持的 `text_generation` provider 已由环境配置；
- `AUTH_SURFACE_MANIFEST_SECRET` 已配置为非 test-mode production secret，供现有 auth manifest 与 domain-separated proactive device claim 共用；缺失时 P2 主动正文 Gate 为 `blocked`；
- provider 不可用时允许自动测试使用 deterministic fake adapter，但真实 E2E Gate 仍为 `blocked`；
- API、SSE、数据、人设和 proactive 合同没有待决冲突。

### 6.3 允许范围

```text
packages/shared/src/companion-conversation-contracts.ts
packages/shared/src/companion-shell-contracts.ts
packages/shared/src/schemas.ts
packages/shared/src/index.ts
packages/shared/src/companion-persona.ts
packages/shared/src/enums.ts
packages/shared/src/feature-flags.ts
packages/shared/src/feature-flags.test.ts
packages/db/src/schema/companion-conversations.ts
packages/db/src/schema/index.ts
apps/api/package.json
apps/api/src/db/schema/**
apps/api/src/db/migrations/<next-real-number>_companion_conversations.sql
apps/api/src/modules/companion-conversation/**
apps/api/src/modules/companion-shell/trigger-arbitration.ts
apps/api/src/modules/companion-shell/presence-control.ts
apps/api/src/config/learning-companion-flags.ts
apps/api/src/config/learning-companion-flags.test.ts
apps/api/src/server.ts
apps/api/src/modules/job/**
docker-compose.dev.yml
docker-compose.yml
.env.example
workers/ai-worker/src/handlers/companion-dialogue.ts
workers/ai-worker/src/handlers/index.ts
workers/ai-worker/src/index.ts
workers/ai-worker/src/schema/**
workers/ai-worker/package.json
apps/web/features/companion-pet/conversation/**
apps/web/features/companion-pet/runtime/**
apps/web/features/companion-pet/surfaces/**
apps/web/app/(workspace)/(default)/companion/conversations/**
tests/e2e/**companion**
```

实际迁移编号取当前最大编号之后的下一个合法编号，并同步仓库现有 schema mirror；不得复用本文占位名。

### 6.4 固定实施顺序

1. 先落 strict shared Zod contracts、错误码和 SSE discriminated union；
2. 写 conversation foundation migration：一次创建 03 合同 §7.1–§7.6 六张表、Drizzle schema、索引、约束、RLS、grants 与 migration integration test；voice provenance 表在 P2 保持无写路径；
3. 实现无副作用 `/companion/bootstrap` 与 repository，所有 user/workspace 查询走 transaction-local RLS context；
4. 实现原子 turn create、idempotency 和 durable event append；
5. 扩展既有 job type，payload 只传 opaque ID；
6. 在 Worker 通过既有 provider registry/`text_generation` 调用 streaming adapter；
7. 落 `companion-persona-v1`，模型输出经过长度、cue 和内容校验；
8. 实现 SSE cursor、heartbeat、重连、cancel 和 latest-generation fence；
9. 实现 Pet conversation store 与 Bubble 流式 preview；
10. 实现幂等 inbox ensure、独立 inbox SSE cursor 和完整会话列表、历史、删除、导出；
11. 接现有 trigger arbitration/presence/budget，生成 durable proactive delivery；
12. 实现 Pet/Main 同时订阅但只提交一次；TTS leader 协议可落基础能力但 P2 不播放；
13. 完成 workspace 隔离、隐私、审计和故障恢复 E2E；
14. 验证 P2 flag off 时不破坏 P1 surface 和已有 Companion 服务。

### 6.5 数据与安全测试

必须覆盖：

- migration fresh/upgrade/repeat；
- shared canonicalJson/hash golden vectors覆盖 Unicode/key/array/正文换行，turn/menu/decision idempotency、payload/context/message/text hash 在 Web/API/Worker 一致；
- RLS user A/user B、workspace A/workspace B、缺失 context、错误 role；
- cookie mutation 缺失/错误 CSRF 必须 403，shared Web request 自动带双提交 header；GET/SSE/export 不绕过 session/RLS；
- bootstrap 只返回当前 session scope/account/feature，global off 返回新 epoch，且零 conversation/provider 副作用；
- `Idempotency-Key` 同参重放与异参冲突；
- conversation cursor 的签名、24h expiry、filter/scope binding、篡改与错误 workspace 全部 fail closed；
- active run 下精确 supersedesGeneration 原子 latest-wins，缺失/陈旧 generation fail closed；
- SSE cursor 必须逐 seq 推进：旧 generation run event consume-only，action event 跨 generation 仍同步且不改变当前 Turn；gap/mismatch 触发 snapshot；
- Pet/Main 任一 surface 创建更高 generation 时，另一 surface 通过 snapshot+replay 安全采用，不丢 accepted event；
- user message/run/job 的原子性；
- 无 dialogue 的首次发送只创建一个 conversation；placeholder→auto title 与用户 PATCH title 并发时行锁收敛且不覆盖 user title，空闲 bootstrap 不堆积空 conversation；
- event seq 单调、Last-Event-ID 重连、重复投递去重；
- fetch-SSE 可读取 409 JSON 后 snapshot；CRLF/LF、64KiB 上限、非法 UTF-8/多 id/content-type、45s heartbeat timeout、429 Retry-After 与 backoff 均可测，且从不重提 turn；
- dialogue 与 inbox 双 SSE cursor 独立，active dialogue 不丢 proactive delivery；
- inbox ensure 并发幂等，空 inbox 不产生消息、预算或通知；
- 两个 device session 并发 viewed 时只有一个可得到 proactive 正文；content_hidden 不领取正文、dismiss/expired 全端收敛；
- 手动 device-local privacy mode 不上传其他应用状态，隐藏 proactive 正文/自动 TTS但不隐藏用户主动会话，关闭后不补播；
- inbox 删除后跨窗口/跨设备重新 ensure，旧消息不恢复且后续合法 delivery 仍可达；
- cancel 后 Worker 迟到 delta/final 被拒绝；
- Worker 在首个 delta 前 crash 可安全重试；首个 delta 后 crash 固定 terminal failed/可重试且不重复 provider 流、不生成假 final；
- API 进程重启和 NOTIFY 丢失后 1 秒 durable poll 恢复；
- 两个 renderer 同时在线不重复 submit；
- 删除/导出只影响当前用户与 workspace；
- export 严格按 03 §12 的 NDJSON record 顺序输出，footer count/hash 可验证；active turn 在 headers 前 409，截断流、跨 workspace 数据、event/provider/device claim secret 均不得形成有效导出；
- job、NOTIFY、日志和 audit 不含 message 正文；
- persona 文本 snapshot/hash、越权完成声明、依赖/内疚话术和隐藏标签 regression；
- presence=quiet/notifications off 不创建主动消息或消费预算；quietHours/DND 只写 `suppressed` inbox 历史且不弹出/不补弹；预算、lease、TTL 正确；
- sourceSurface 字符上限、turn/create/concurrency 限额与 `Retry-After`，达限零持久副作用；

除了通用 Gate，还运行当前仓库的 PostgreSQL integration lifecycle；新增测试必须进入正常 `npm test` 或明确的新 Postgres test script，不能只留手工 SQL。

P2 固定新增并运行：

```text
apps/api/src/integration-tests/companion-migration-postgres.integration.ts
apps/api/src/integration-tests/companion-rls-postgres.integration.ts
apps/api/src/integration-tests/companion-conversation-postgres.integration.ts
apps/api/src/integration-tests/companion-sse-postgres.integration.ts
workers/ai-worker/src/integration-tests/companion-dialogue-postgres.integration.ts
tests/e2e/tests/companion-text-conversation.spec.ts
```

API 和 Worker 对应 package script 固定名为 `test:companion:postgres`。开发栈重建后执行：

```bash
docker compose -p ailearn-dev -f docker-compose.dev.yml exec api npm run test:companion:postgres
docker compose -p ailearn-dev -f docker-compose.dev.yml exec worker npm run test:companion:postgres
(cd tests/e2e && npm test -- --grep "@companion-text")
```

Postgres 脚本必须 fail closed：缺少数据库或 role 凭据时退出非零，不把 skip 当通过。

### 6.6 真实 E2E 证据

- Pet 输入一条真实消息，保存 POST、SSE accepted/delta/final 的脱敏时间线；
- 流式中重载 Pet，按 cursor 恢复且无重复字；
- Pet 与 Main 同时打开，消息只创建一次；
- 取消后至少等待一个迟到事件窗口，UI 不再变化；
- 从二级菜单打开完整历史，关闭 Main 后 Pet 继续；
- 切换 workspace 后旧 stream、bubble 和 history 立即隔离；
- quiet/notifications-off 零 delivery、DND suppressed history、moderate/active 可见 delivery 的主动消息场景；
- Web/API/Worker/Postgres 容器状态与日志；
- provider 请求只记录元数据，不保存 secret 或完整正文。

### 6.7 P2 通过条件

可以称为“文字桌宠可用”，不能称为语音桌宠或完整学习伴星。真实 provider、真实 Postgres、真实 SSE 重连和容器日志任一未验证即 `blocked`。随后停止。

---

## 7. P3 — Push-to-Talk Half-Duplex Voice

### 7.1 输入 Gate

- P2 `gate_passed`；Owner 批准 `P3`；
- macOS 麦克风权限可真实测试；
- `SILICONFLOW_API_KEY` 或当前受支持 ASR provider 已由环境配置；
- edge-tts service 健康且共享 token 已配置；
- Owner 已批准 API image 增加 Alpine `ffmpeg/ffprobe`，并记录镜像体积、许可证与供应链影响；未批准时 P3 为 `blocked`；
- 使用 03 合同冻结的 ASR/TTS profile，raw audio retention 决策未被 Owner 修改；
- 无真实麦克风/provider 时自动测试可以继续，阶段结论必须 `blocked`。

### 7.2 允许范围

```text
apps/web/features/companion-pet/voice/**
apps/web/features/companion-pet/runtime/**
apps/web/features/companion-pet/surfaces/**
apps/api/src/modules/learning-sessions/voice-routes.ts
apps/api/src/modules/learning-sessions/voice-service.ts
apps/api/src/modules/learning-sessions/voice-providers/**
apps/api/Dockerfile
packages/shared/src/voice-artifact-contracts.ts
packages/shared/src/companion-conversation-contracts.ts
packages/shared/src/desktop-pet-contracts.ts
packages/shared/src/index.ts
packages/shared/src/feature-flags.ts
packages/shared/src/feature-flags.test.ts
apps/api/src/config/learning-companion-flags.ts
apps/api/src/config/learning-companion-flags.test.ts
workers/ai-worker/src/handlers/companion-dialogue.ts
workers/ai-worker/src/schema/**
workers/ai-worker/package.json
apps/desktop/electron-builder.yml
apps/desktop/src/permissions/media-permission.ts
apps/desktop/src/permissions/media-permission.test.ts
```

正式 Learning Session Voice Artifact 的语义与保留规则不可被日常聊天复用或改变。P3 日常语音的 transcript 作为普通 user message 提交。

### 7.3 固定实施顺序

1. 实现 Voice state reducer 与资源清理测试；
2. 配置 macOS usage description 与 Electron trusted-route permission handler，只在明确 press 手势后请求麦克风；
3. 以固定 argv/无 shell/3 秒 timeout 的 ffprobe 实测时长，实现 200ms–60 秒、最大 10 MB、取消方向、magic-byte 和空音频检测，并验证所有临时文件路径均清理；
4. 复用 `/voice/transcribe`，返回可见 transcript；
5. transcript 作为普通 P2 turn 自动提交，不创建正式 Learning Session Voice Artifact；按 03 §7.5 创建 pending Companion voice provenance 并在 turn 事务绑定；
6. 按句切分 final/稳定文本，建立最多 20 段、总计最多 2000 字的 TTS 队列；
7. 通过 Web Locks 优先、BroadcastChannel fallback 选唯一 playback leader；
8. speaking 前关闭所有 MediaStreamTrack；
9. barge-in 固定执行停止 source、清队列、释放 lock、generation fence、再开麦；
10. 落当前 queue 停止、账号级 `voiceOff`、权限拒绝和文字 fallback；P3 不实现历史消息语音重播；
11. 验证临时音频删除，硬上限一小时；
12. 关闭 P3 flag，确认 P2 文字路径完整可用。

### 7.4 自动与故障测试

- permission denied/no device/not allowed；
- 0 字节、静音、错误 MIME、超过 60 秒、超过 10 MB；
- MediaRecorder MIME fallback 顺序、magic-byte/扩展名不一致和无支持编码器；
- ASR 4xx/5xx/timeout/invalid response；
- voice operationEpoch 拒绝迟到 permission/track/upload/ASR/playback；成功 ASR 的 voiceArtifactId/hash/expiry 与 turn 原子绑定，重复/过期 artifact fail closed；
- TTS 4xx/5xx/timeout/空音频；
- 非 allowlist voice 拒绝，配置中的 ASR model 与实际 provider request 一致；
- 分句、队列上限、乱序、重复、旧 generation；
- Worker 单一切句所有权、segmentId/ordinal 确定性，以及客户端不从 delta 重复切句；
- Pet/Main leader 竞争、leader crash、TTL 接管；
- 非 leader surface 发起 barge-in，leader stop ack 或 fail-closed 路径；
- speaking 与 listening 永不同时成立；
- hidden/suspend/workspace switch 全部释放 track/audio node；
- raw audio、transcript 和 secret 不进入普通日志。

### 7.5 真机证据

- 首次授权、拒绝后文字恢复、重新授权；
- packaged macOS app 的系统权限文案与合同一致，非可信 route 的 media 请求被拒绝；
- 点按开始、再次点按结束的录音→转写→真实 AI 回复→TTS；
- 播报中点按麦克风，200ms 内停止播放并进入 listening 状态；
- Pet/Main 同开只有一个窗口发声；
- AI 播报不被再次转写成用户消息；
- 拔出/切换输入设备、系统休眠/唤醒；
- edge-tts/API/Web 日志及临时文件清理证据。

P3 至少执行一次当前 CPU 架构的 packaged smoke；Apple Silicon 使用 `make desktop-dist-arm64`。只在 `make desktop-dev` 中授权成功不足以通过麦克风 Gate。

### 7.6 P3 通过条件

P0–P3 全部通过后才可称为 `Usable Desktop Pet V1`。流式 ASR/WSS 不属于 P3；半双工点按切换录音达标即可。随后停止并由 Owner 决定是否投入角色生产资产。

---

## 8. P4 — Production Character and Performance

### 8.1 输入 Gate

- Owner 批准 `P4`；
- 同一角色的高清分层原画、补绘、Live2D model、动作/表情清单和商业再分发权均有书面记录；
- Cubism SDK/Core 的当前许可、收入/规模门槛和打包方式由 Owner/法务确认；
- Soullink 版本、MIT 义务、beta 风险与 adapter 退出路径已批准；
- 任一项缺失时维持 Sprite Driver，P4 `blocked`，不得自动重绘另一角色。

### 8.2 允许范围

```text
apps/web/features/companion-pet/character/CharacterDriver.ts
apps/web/features/companion-pet/character/Live2DCharacterDriver.ts
apps/web/features/companion-pet/character/SoullinkPerformanceAdapter.ts
apps/web/features/companion-pet/character/**
apps/web/public/images/companion/pet/live2d-v1/**
packages/shared/src/companion-character-contracts.ts
packages/shared/src/index.ts
packages/shared/src/feature-flags.ts
packages/shared/src/feature-flags.test.ts
apps/api/src/config/learning-companion-flags.ts
apps/api/src/config/learning-companion-flags.test.ts
apps/web/package.json
apps/web/package-lock.json
apps/desktop/electron-builder.yml
THIRD_PARTY_NOTICES*
```

### 8.3 固定实施顺序

1. 先归档资产来源、hash、许可和模型 manifest；
2. 在隔离 spike 中验证 Cubism 与 Electron/Next 打包；
3. 所有第三方表现能力包在本项目 adapter 后；
4. 实现 model profile 和参数 allowlist/clamp；
5. 实现 Idle、blink、gaze、VAD、FACS、lipsync 的优先级与恢复；
6. cue 只接受合同中的高层语义；
7. context loss/model load/低性能时自动回退同一角色 Sprite；
8. reduced motion 与 animationOff 完全绕过循环表现；
9. 完成许可证清单、打包检查和资源完整性验证；
10. 24h 之前先做 2h 表现 soak。

### 8.4 Gate 与证据

- Owner 逐项确认 idle/listen/think/speak/uncertain/encourage/celebrate 仍是指定角色；
- LLM 任意参数注入测试失败关闭；
- lipsync 开始/停止与音量一致，不残留张嘴；
- 动作层不会永久覆盖 blink/gaze/idle；
- WebGL/context 丢失、资源 404、模型损坏自动回退；
- idle/说话/动作三档 CPU、GPU、内存和帧率；
- packaged app 内资源、NOTICE 和许可可读取；
- Docker Web build 与 Electron packaged smoke 通过。

P4 不允许接 canonical 学习动作。通过后停止。

---

## 9. P5 — Trusted Learning Action Bridge

### 9.1 输入 Gate

- P3 已通过；P4 可通过或继续使用 Sprite fallback；
- Owner 批准 `P5`；
- 方案 12 的 Learning Session、Assessment、Commit 和 canonical write 约束仍可运行；
- 第一批 action enum、确认文案和页面路由已冻结。

### 9.2 允许范围

```text
packages/shared/src/companion-conversation-contracts.ts
packages/shared/src/desktop-pet-contracts.ts
packages/shared/src/index.ts
packages/shared/src/feature-flags.ts
packages/shared/src/feature-flags.test.ts
packages/db/src/schema/companion-actions.ts
packages/db/src/schema/companion-conversations.ts
packages/db/src/schema/index.ts
apps/api/package.json
apps/api/src/db/schema/**
apps/api/src/db/migrations/<next-real-number>_companion_action_bridge.sql
apps/api/src/config/learning-companion-flags.ts
apps/api/src/config/learning-companion-flags.test.ts
apps/api/src/modules/companion-conversation/dialogue-router.ts
apps/api/src/modules/companion-conversation/learning-action-bridge.ts
apps/api/src/modules/companion-conversation/**proposal**
workers/ai-worker/src/handlers/companion-action.ts
workers/ai-worker/src/handlers/companion-dialogue.ts
workers/ai-worker/src/handlers/index.ts
workers/ai-worker/src/index.ts
workers/ai-worker/src/schema/**
workers/ai-worker/package.json
apps/web/features/companion-pet/**
apps/web/app/(workspace)/**/companion/**
apps/api/src/modules/learning-sessions/**
tests/e2e/**companion**
```

只通过 Learning Session 公开服务接线；不得从 companion repository 直接写 mastery、scheduler、Card truth、Assessment 或 Commit 表。

### 9.3 固定实施顺序

1. 冻结第一批 typed action enum/strict payload，并以 P5 migration 创建 action tables、给 turn run 增加冻结 router decision 字段；
2. 落 Learning service 只读 menu context adapter 与稳定 revision；无 resume/start candidate 时禁用对应菜单；
3. 实现菜单 proposal create 的双消息/proposal/event 原子事务，纯导航只走 typed route；
4. router 只生成 proposal，不执行副作用；
5. 气泡展示目标、影响和确认/取消；
6. 只有确认 API 在原子事务中消费 proposal；
7. bridge 调用现有 Learning Session/service 公共入口；
8. Worker 只处理获准的慢动作并回传真实状态；
9. presentation 把服务结果转换成人设口吻，不改变事实；
10. page context 只传用户明确授权的 opaque entity ref；
11. assessment 期间禁止提示答案并保持独立 handoff；
12. rollback 关闭 action flag 后，普通 P3 对话仍可用。

### 9.4 必测矩阵

- confirm、reject、expired、duplicate confirm、并发 confirm；
- action.decision/action.expired 跨 Pet/Main 同步，reject/expire 零 Learning 副作用；
- expected payload hash 改变、同 idempotency key 异参、每 conversation 单一 pending proposal；
- menu context 稳定排序/revision、无候选 disabled、stale revision 零写入、菜单 create key 同参重放/异参冲突；
- continue/start 菜单只创建待确认 proposal；review/card/star map 只导航，未确认零 Learning 副作用；
- assistant final/action_ref/proposal/action.proposed 原子创建，失败不留下悬空 proposal；
- 无权限/跨 workspace/过期 entity ref；
- page context discriminated union、ID 关系重查、伪造 sharing/revision/requestedCapability 拒绝；grounded grant 的 HMAC/scope/5min TTL/page 字段/partial-unique replay 均 fail closed，只有显式 session UI + 实时 assistance policy 才可 proposal；
- 服务成功、可重试失败、终态失败、Worker crash/restart；
- Renderer/API/Worker 重启后从 proposal/action run snapshot 恢复，不重复执行；
- navigation 与异步 Learning success 都恰好创建一条 durable result message，result_ref 指向真实 action run；失败不创建假 result，reload/export 后结果仍可见；
- active action run 期间 DELETE conversation 返回 409 且保留回执链；pending proposal 可删除且零 Learning 副作用；
- 普通聊天和恶意 prompt 无法写 canonical 表；
- `companion-action-router-v1` 导出字符串逐字满足 578 UTF-8 bytes 与冻结 SHA-256；lexeme prefilter、0.90 阈值、invalid JSON/timeout 回落 none 均有 regression；
- classifier 只收到 canonical strict userText/availableIntents、先于 persona 调用；payload/summary 全由只读 adapter 构造，main generation 失败不遗留 proposal；
- 角色不会在服务完成前说“已创建/已保存/已掌握”；
- Card → Pet → Session → Answer → Assessment → Commit → Return 真实纵切；
- 正式 Voice Artifact 不与日常 voice message 混淆；
- content-free audit、action idempotency、proposal/action run RLS 与 terminal race；
- `AllowedMainRouteV1` 每个 variant 映射正确，任意 pathname/query/URL 被拒绝。

P5 固定新增并运行：

```text
apps/api/src/integration-tests/companion-action-migration-postgres.integration.ts
apps/api/src/integration-tests/companion-action-rls-postgres.integration.ts
apps/api/src/integration-tests/companion-action-bridge-postgres.integration.ts
workers/ai-worker/src/integration-tests/companion-action-postgres.integration.ts
tests/e2e/tests/companion-learning-action.spec.ts
```

API/Worker package script 固定名为 `test:companion-actions:postgres`；缺少真实 Postgres/Learning service 时 fail closed，不以 mock 纵切通过 P5。

```bash
docker compose -p ailearn-dev -f docker-compose.dev.yml exec api npm run test:companion-actions:postgres
docker compose -p ailearn-dev -f docker-compose.dev.yml exec worker npm run test:companion-actions:postgres
(cd tests/e2e && npm test -- --grep "@companion-learning-action")
```

### 9.5 P5 通过条件

只有真实 canonical 纵切和拒绝零副作用均通过，才可称为 `AI Learning Companion`。P5 不包含常开麦克风或跨应用屏幕感知。随后停止。

---

## 10. P6 — Streaming Voice, Platform Hardening and RC

### 10.1 输入 Gate

- P0–P5 已通过并有 Owner 接受记录；
- Owner 批准 `P6`；
- 目标平台矩阵、签名账号、更新源、隐私文本和支持声明已冻结；
- streaming ASR/TTS provider 的协议、费用、配额和数据处理条款已批准。
- README 的 `streamingVoiceTransport` 已由 Owner 从 blocked 改为 approved，且 03 或单独 Owner 批准的 addendum 已冻结 WSS URL/subprotocol、鉴权、control/binary frame schema、codec/sample rate、sequence/ack/backpressure、resume、TTL/限额、错误码、provider fallback、观测脱敏和 integration test；只有 provider 资料获批但没有该 wire contract 时仍为 `blocked`，实施 Agent 不得自行发明协议。

### 10.2 允许范围

P6 可修改 Desktop、Web voice、API voice transport、部署、CI、打包和文档，但不得降低 P0–P5 的安全/隐私/canonical Gate。任何新平台专属 native 依赖必须单独许可与供应链审计。

### 10.3 固定实施顺序

1. AudioWorklet capture 与 bounded buffer；
2. WSS auth、backpressure、resume 和 reconnect；
3. streaming ASR partial/final 与 P3 transcript 语义对齐；
4. streaming TTS 仍遵守唯一 leader、generation fence 和 barge-in；
5. macOS 回归；
6. Windows 真机窗口、DPI、音频、签名与安装验证；
7. Linux X11/Wayland 分开验证，未通过则明确不支持；
8. tray/menu bar、自动更新、失败回滚；
9. 键盘、读屏、reduced motion；Main/browser fallback 200% page zoom，Electron Pet 做 OS DPI/屏幕放大镜验证；
10. 故障矩阵、隐私审计、24h soak；
11. 旧 Anchor/Panel 删除 Gate 与可恢复迁移；
12. 生成 release manifest，执行发布检查。

### 10.4 24h soak 最低采样

至少每 30 分钟记录：

- Electron main、Pet renderer、Main renderer 的 CPU/内存；
- GPU process 与窗口数；
- MediaStreamTrack、AudioContext、SSE/WSS、timer 数；
- Pet 坐标、display fingerprint 和 click-through 状态；
- API/Worker restart count、DB connection、job backlog；
- 最近错误计数，不记录消息正文。

soak 场景必须包含休眠/唤醒、锁屏、网络断开、provider timeout、API/Worker restart、显示器拔插、workspace 切换、Main 多次开关和至少一次更新/回滚演练。

### 10.5 RC Gate

- `make release-check` 通过；
- 目标平台 packaged build、签名、安装、升级、回滚真实通过；
- 24h 无持续麦克风、窗口漂移、音频泄漏或单调内存增长；
- 支持矩阵不宣称未实测平台；
- security、privacy、license、NOTICE 和角色权属审计通过；
- 旧实现只在 fallback、迁移和回滚证据齐全后删除；
- Web/API/Worker/edge-tts/Electron 日志无未解释错误。

P6 Gate 通过后才可标记 Release Candidate；正式发布仍需 Owner 独立批准。

---

## 11. 阶段声明对照表

| 已通过阶段 | 允许的准确表述 | 禁止的夸大表述 |
| --- | --- | --- |
| P0 | 透明桌宠技术可行性已验证 | 桌宠已完成 |
| P0–P1 | 桌宠 Surface Prototype 已通过视觉审核 | AI 桌宠可用 |
| P0–P2 | 文字桌宠可用 | 语音已完成、学习伴星已完成 |
| P0–P3 | Usable Desktop Pet V1 | Live2D/学习动作/发布已完成 |
| P0–P4 | Expressive Character 已完成 | AI 学习能力已完成 |
| P0–P5 | AI Learning Companion 已完成既定纵切 | 已达到发布质量 |
| P0–P6 | Release Candidate Gate 已通过 | 已正式发布 |

最后一条原则：**阶段报告描述证据已经证明的结果，不描述文件数量、主观完成度或未来预期。**
