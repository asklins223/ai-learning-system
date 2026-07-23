#!/usr/bin/env node
/**
 * AIQ-01 PR Mock 门禁 CLI 入口
 *
 * 用法：node --import tsx src/cli/pr-gate.ts
 *
 * 这是 PR 层 AI 质量门禁的命令行入口。
 * 执行后输出 JSON 格式的门禁结果，退出码 0 表示通过，1 表示失败。
 *
 * 对应 ADR-0005 第 2 条：
 * "PR 只运行 schema/parser/alignment/scorer 与固定 Mock，不访问付费网络"。
 */

import { runPRGate } from "../pr-runner.ts";

const result = runPRGate();

// 输出 JSON 格式的门禁结果
console.log(JSON.stringify(result, null, 2));

// 退出码：通过为 0，失败为 1
process.exit(result.passed ? 0 : 1);
