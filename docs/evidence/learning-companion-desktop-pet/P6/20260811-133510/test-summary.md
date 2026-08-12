# P6 — Platform Hardening and RC：测试摘要（evidence）

验证日期：2026-08-11（P6-1 ~ P6-12，DB 为本地 ailearn-dev postgres）

## 全量矩阵（全绿）

| 项目 | 结果 |
|---|---|
| api `npm test` | 3010 / 0 |
| api `tsc --noEmit` | 0 error |
| web `tsc --noEmit` | 0 error |
| web `npm run build` | Compiled successfully + Generating static pages (17/17) |
| desktop `tsc --noEmit` | 0 error |
| migrate（根治后） | 96 total, 0 to run（显式 all applied） |

## P6 专项测试

| 测试 | 结果 |
|---|---|
| web `companion-audio-buffer.test.ts`（P6-1 环形缓冲） | 6/6 |
| desktop `tray-menu.test.ts`（P6-8 tray 菜单 + 更新状态机） | 6/6 |
| desktop `soak-sampler.test.ts`（P6-10 采样器 + 脱敏） | 5/5 |
| web `live2d-gate.test.ts`（P6-9 reduced motion） | 4/4 |
| web `companion-live2d-manifest.test.ts`（Mao PRO 免费修正） | 6/6 |

## 发布相关

- release manifest 生成：`outputs/release-manifest.json`（version 0.5.0，含 git/migration/testSummary）；contract 校验：非 release tag → not required（正常）。
- `make release-check`：阻塞于 `verify-release-inputs`（checkout 不干净 + 0080–0095 migration SQL 未 git 跟踪——工作区未提交）；此为 release 前置条件，非代码问题。

## 未通过 / 未跑

- 无 P6 测试失败。
- 未跑（记录 known-issue）：Windows/Linux 真机、24h soak 真机采样、Electron 真机启动/GPU/OS DPI/放大镜、旧 Anchor/Panel 实际删除（需 Owner 确认 + commit）。
