import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gatewayErrorCodeValues } from "@ailearn/shared/desktop-ipc-contracts";

/**
 * 每一个网关错误码都必须有一句人话（doc 34 L13 的那一族：码存在、没人读它 = 等于没有）。
 *
 * `gatewayErrorMessage` 的 switch 带 `default` 兜底，所以新加一个码而忘了配文案，
 * **编译不会红、测试也不会红**，用户看到的是一句和实际原因无关的通用话——
 * 这次要修的 `ai_consent_required` 正是这么藏了一轮的（它先前干脆没有码，
 * 和"这个账号没权限"共用一句）。
 *
 * 两个方向都断：
 * - 码没有文案 → 红（这条是目的）；
 * - 文案挂在已经不存在的码上 → 也红（否则这张表会留着骗人）。
 */
/**
 * 文案不止一处写：`gatewayErrorMessage` 管通用那句，登录那道门
 * （`desktop-gate.ts` 的 `invalid_credentials`）自己给了更准的一条。
 * 所以判"这个码有没有人话"要按**读它的地方**数，而不是按某一个函数数——
 * 只盯一个函数，就会把已经有专属文案的码报成缺口（第一次跑就是这样）。
 */
const COPY_SOURCES = [
  "../renderer/src/app/desktop-client.ts",
  "../renderer/src/app/desktop-gate.ts",
].map((relative) => {
  const source = readFileSync(resolve(__dirname, relative), "utf8");
  expect(source.length, `${relative} 读出来是空的，这条门禁就成了假绿`).toBeGreaterThan(200);
  return source;
});

function mentionedCodes(sources: string[]): Set<string> {
  const found = new Set<string>();
  for (const code of gatewayErrorCodeValues) {
    // 只认字符串字面量：注释里提一句不算"有人读它"。
    if (sources.some((source) => source.includes(`"${code}"`))) found.add(code);
  }
  return found;
}

function copyFunctionBody(source: string): string {
  const start = source.indexOf("export function gatewayErrorMessage");
  expect(start, "没在 desktop-client.ts 里找到 gatewayErrorMessage（文件挪了还是改名了？）").toBeGreaterThanOrEqual(0);
  const body = source.slice(start);
  const end = body.indexOf("\n}\n");
  expect(end, "gatewayErrorMessage 的函数体没切出来，判据会退化成整文件 grep").toBeGreaterThan(0);
  return body.slice(0, end);
}

describe("网关错误码与界面文案一一对应", () => {
  it("读的确实是那两处（清单非空、且没有把整个仓库当成清单）", () => {
    const mentioned = mentionedCodes(COPY_SOURCES);
    // 合同那一侧也得有分量：枚举空掉的话"每个码都有人话"会当场变成真话。
    expect(gatewayErrorCodeValues.length).toBeGreaterThanOrEqual(25);
    expect(mentioned.size).toBeGreaterThan(20);
    expect(COPY_SOURCES.length).toBe(2);
  });

  it("每一个码都有界面读它，不落 default 兜底", () => {
    const mentioned = mentionedCodes(COPY_SOURCES);
    const missing = gatewayErrorCodeValues.filter((code) => !mentioned.has(code));
    expect(missing, `这些码只会落到那句通用话上：${missing.join(", ")}`).toEqual([]);
  });

  it("没有挂在已不存在的码上的死文案", () => {
    const body = copyFunctionBody(COPY_SOURCES[0]);
    const declared = new Set<string>(gatewayErrorCodeValues);
    const orphans = [...body.matchAll(/case "([a-z_]+)":/g)]
      .map((match) => match[1])
      .filter((code) => !declared.has(code));
    expect(orphans, `这些 case 对应的码已经从合同里删掉了：${orphans.join(", ")}`).toEqual([]);
  });
});
