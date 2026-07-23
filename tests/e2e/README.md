# @ailearn/e2e — Playwright 浏览器验收底座

> 对应 ADR-0008：Playwright 浏览器验收底座与矩阵

## 目录结构

```
tests/e2e/
├── playwright.config.ts     # Playwright 配置（PR/Nightly/RC profile）
├── lib/
│   ├── console-allowlist.ts # 全局错误监听 + console allowlist
│   └── fixtures.ts          # 登录 fixture + 错误收集
├── tests/
│   └── review-attempt.spec.ts  # Review Attempt 旅程 (LOOP-01/02)
└── package.json
```

## 运行

### 本地开发

需要运行中的 Web (3000) 和 API 服务。通过环境变量提供凭据：

```bash
E2E_DEV_EMAIL=owner@example.com \
E2E_DEV_PASSWORD=secret \
E2E_DEV_WORKSPACE_SLUG=default \
npm --prefix tests/e2e test
```

### CI

CI 使用 seed CLI 生成 fixture，输出 JSON 到 `E2E_SEED_OUTPUT`：

```bash
# 1. Seed CLI
npm run seed -- --profile pr --run-id <uuid> --output /tmp/seed-output.json

# 2. 运行 E2E
E2E_BASE_URL=http://localhost:3000 \
E2E_SEED_OUTPUT=/tmp/seed-output.json \
npm --prefix tests/e2e test
```

### Profile

| Profile | 命令 | 浏览器/视口 | 用途 |
| --- | --- | --- | --- |
| PR smoke | `npm run test:pr` | Chromium 1440 | PR 门禁 |
| Nightly | `E2E_PROFILE=nightly npm run test:nightly` | Chromium 390/768/1440 + Firefox 1440 | 夜间回归 |
| RC | `E2E_PROFILE=rc npm test` | 全矩阵 + 边界数据 | 发布候选 |

## 错误门禁 (ADR-0008 §4)

- `pageerror` / 资源安全错误：永不 allowlist，直接失败。
- `console.error` / `console.warning`：必须精确匹配 `consoleAllowlist`，每条记录 Issue、Owner、审批、14 天到期日。
- `requestfailed`：favicon 除外，其余直接失败。
- 重试仅用于收集第二份 trace，首轮失败仍判失败。

## Fixture 契约

每个 test worker 使用独立 `runId`；fixture 包含两个 workspace、Owner/member、到期 review schedule 等。当前可执行契约以本目录的 fixture 与 seed 代码为准。
