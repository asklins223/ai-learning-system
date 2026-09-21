// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayResultV1, RequestMetaV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { setCurrentWorkspaceEpoch } from "./desktop-client";
import { subscribeGateInvalidation } from "./gate-invalidation";
import {
  clearAccountSignOutNotice,
  peekAccountSignOutNotice,
  signOutCurrentAccount,
} from "./account-signout";

/**
 * 退出登录只有两种值得区分的结局：这台设备和学习服务**都**干净了，以及这台设备
 * 干净了但学习服务那边没收到撤销。「请求整个失败」又是第三种，因为主进程在失败的
 * 分支里同样已经把本机登录状态清掉了——把它压成「已退出」或压成「失败了，什么都
 * 没发生」都是假话。
 *
 * 这句话必须在门禁把整棵房间顶掉之后还活着，所以它不停在组件 state 里，也不停在
 * 房间 store 里（边界重置会连它一起清），而是停在本模块。这些用例钉住的就是这个。
 */

const invalidations: string[] = [];
subscribeGateInvalidation((code) => { invalidations.push(code); });

afterEach(() => {
  Reflect.deleteProperty(window, "ailearn");
  invalidations.length = 0;
  clearAccountSignOutNotice();
});

type SignOutPayload = { loggedOut: true; serverRevoked: boolean };

function envelope(data: SignOutPayload): GatewayResultV1<SignOutPayload> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "request-signout-test",
    correlationId: "correlation-signout-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function failure(code: "api_unavailable" | "forbidden" | "validation"): GatewayResultV1<SignOutPayload> {
  return {
    version: 1,
    ok: false,
    requestId: "request-signout-test",
    correlationId: "correlation-signout-test",
    schemaRevision: "desktop-ipc-v1",
    error: { code, safeMessageKey: `error.${code}`, retry: "safe_retry" },
  };
}

function stubLogout(
  implementation: (input: { meta: RequestMetaV1 }) => Promise<GatewayResultV1<SignOutPayload>>,
) {
  const logout = vi.fn(implementation);
  Object.defineProperty(window, "ailearn", { configurable: true, value: { auth: { logout } } });
  return logout;
}

describe("退出登录这个动作", () => {
  it("本机与学习服务都干净了，就不给登录页留一句话", async () => {
    const logout = stubLogout(async () => envelope({ loggedOut: true, serverRevoked: true }));

    await signOutCurrentAccount();

    expect(logout).toHaveBeenCalledOnce();
    expect(peekAccountSignOutNotice()).toBeNull();
    expect(invalidations).toEqual(["auth_required"]);
  });

  it("本机退出了、学习服务没收到撤销：这句话要活着到达登录页", async () => {
    stubLogout(async () => envelope({ loggedOut: true, serverRevoked: false }));

    await signOutCurrentAccount();

    const notice = peekAccountSignOutNotice();
    expect(notice).toContain("这台设备已经退出登录");
    expect(notice).toContain("没能通知学习服务撤销");
    expect(invalidations).toEqual(["auth_required"]);
  });

  it("请求整个失败时说的是另一句话，不与上一种结局合并", async () => {
    stubLogout(async () => failure("api_unavailable"));

    await signOutCurrentAccount();

    const notice = peekAccountSignOutNotice();
    expect(notice).toContain("退出这一步没有全部完成");
    expect(notice).not.toContain("没能通知学习服务撤销");
  });

  it("门禁重读会话不依赖请求是否成功，原始报错也不端给用户", async () => {
    stubLogout(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
    });

    await signOutCurrentAccount();

    const notice = peekAccountSignOutNotice();
    expect(invalidations).toContain("auth_required");
    expect(notice).not.toContain("ECONNREFUSED");
    expect(notice).toContain("这台设备上的登录状态已经清空");
  });

  it("一次只留最近一次的结论，前一次的不会叠加", async () => {
    stubLogout(async () => envelope({ loggedOut: true, serverRevoked: false }));
    await signOutCurrentAccount();
    expect(peekAccountSignOutNotice()).toContain("没能通知学习服务撤销");

    stubLogout(async () => envelope({ loggedOut: true, serverRevoked: true }));
    await signOutCurrentAccount();

    expect(peekAccountSignOutNotice()).toBeNull();
  });

  it("带着当前学习空间边界去退出，不留漏传 epoch 的口子", async () => {
    setCurrentWorkspaceEpoch(7);
    const logout = stubLogout(async () => envelope({ loggedOut: true, serverRevoked: true }));

    await signOutCurrentAccount();

    expect(logout.mock.calls[0]?.[0]).toMatchObject({ meta: { version: 1, workspaceEpoch: 7 } });
    setCurrentWorkspaceEpoch(0);
  });
});
