// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayResultV1, RequestMetaV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { HudAccountCard } from "./HudAccountCard";
import { useRoomStore } from "../../app/room-store";

/**
 * 顶栏那个小框要回答两件事：这台设备登录的是谁，以及要换人时怎么退出。
 *
 * 退出必须按两次——一次点击就把整间房间换成登录页，点错的人连「我刚才是不是
 * 把自己登出去了」都来不及问。头像则是另一个坑：它按邮箱记账，不然换过账号之后
 * 上一个账号的脸会留在屏幕上。
 */

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ accountIdentity: null, accountAvatar: null });
});

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "request-account-test",
    correlationId: "correlation-account-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function signIn(identity: { email: string; displayName: string | null }) {
  useRoomStore.getState().setAccountIdentity(identity);
}

function stubProfile(profile: { displayName: string | null; avatarUrl: string | null }, avatarBytes?: { mimeType: string; imageBase64: string }) {
  const getProfile = vi.fn(async () => ok({ version: 1 as const, ...profile }));
  const getAvatar = vi.fn(async (_input: { meta: RequestMetaV1; request: { version: 1; objectKey: string } }) =>
    ok({ version: 1 as const, ...avatarBytes }));
  const logout = vi.fn(async () => ok({ loggedOut: true as const, serverRevoked: true as const }));
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: { auth: { getProfile, getAvatar, logout } },
  });
  return { getProfile, getAvatar, logout };
}

describe("顶栏账户小框", () => {
  it("用户名与账号同时在场：有显示名时不拿邮箱顶替", () => {
    signIn({ email: "asklins@example.com", displayName: "Asklins" });
    stubProfile({ displayName: "Asklins", avatarUrl: null });
    render(<HudAccountCard onOpenAccount={() => {}} />);

    expect(screen.getByText("Asklins")).toBeTruthy();
    expect(screen.getByText("账号 asklins@example.com")).toBeTruthy();
  });

  it("没有显示名时邮箱顶上，第二行不再抄一遍同一个邮箱", () => {
    signIn({ email: "only@email.com", displayName: null });
    stubProfile({ displayName: null, avatarUrl: null });
    render(<HudAccountCard onOpenAccount={() => {}} />);

    expect(screen.getByText("only@email.com")).toBeTruthy();
    expect(screen.getByText("这个账号没有设置显示名")).toBeTruthy();
    expect(screen.queryByText(/^账号 only@email\.com$/)).toBeNull();
  });

  it("第一次点退出只武装自己，不发请求", () => {
    signIn({ email: "asklins@example.com", displayName: null });
    const { logout } = stubProfile({ displayName: null, avatarUrl: null });
    render(<HudAccountCard onOpenAccount={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^退出登录/ }));

    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByText("再点确认")).toBeTruthy();
  });

  it("第二次点才真的退出这台设备", async () => {
    signIn({ email: "asklins@example.com", displayName: null });
    const { logout } = stubProfile({ displayName: null, avatarUrl: null });
    render(<HudAccountCard onOpenAccount={() => {}} />);

    const row = screen.getByRole("button", { name: /^退出登录/ });
    fireEvent.click(row);
    fireEvent.click(row);
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  });

  it("档案里没有头像时只问一次，之后每次点开都不再重复请求", async () => {
    signIn({ email: "asklins@example.com", displayName: null });
    const { getProfile, getAvatar } = stubProfile({ displayName: null, avatarUrl: null });

    const first = render(<HudAccountCard onOpenAccount={() => {}} />);
    await waitFor(() => expect(getProfile).toHaveBeenCalledOnce());
    expect(getAvatar).not.toHaveBeenCalled();
    first.unmount();

    render(<HudAccountCard onOpenAccount={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(getProfile).toHaveBeenCalledOnce();
    expect(useRoomStore.getState().accountAvatar).toEqual({ email: "asklins@example.com", src: "" });
  });

  it("设过头像时取回字节并发布，按钮与小框共用同一张脸", async () => {
    signIn({ email: "asklins@example.com", displayName: "Asklins" });
    const { getAvatar } = stubProfile(
      { displayName: "Asklins", avatarUrl: "/api/uploads/avatars/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png" },
      { mimeType: "image/png", imageBase64: "aGVsbG8=" },
    );
    render(<HudAccountCard onOpenAccount={() => {}} />);

    await waitFor(() => expect(getAvatar).toHaveBeenCalledOnce());
    // objectKey 的写法以 main 的 `avatarObjectKeySchema` 为准：`avatars/<uuid>/<uuid>.png`，
    // 去掉的是 `/api/uploads/` 这一段前缀。
    expect(getAvatar.mock.calls[0]?.[0]).toMatchObject({
      request: {
        version: 1,
        objectKey: "avatars/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png",
      },
    });
    expect(useRoomStore.getState().accountAvatar).toEqual({
      email: "asklins@example.com",
      src: "data:image/png;base64,aGVsbG8=",
    });
    await waitFor(() => expect(screen.getByAltText("你的头像")).toBeTruthy());
  });

  it("上一个账号留下的头像不会画在新账号的脸上", () => {
    useRoomStore.getState().setAccountAvatar({ email: "old@example.com", src: "data:image/png;base64,old" });
    signIn({ email: "new@example.com", displayName: "新人" });
    stubProfile({ displayName: "新人", avatarUrl: null });
    render(<HudAccountCard onOpenAccount={() => {}} />);

    expect(screen.queryByAltText("你的头像")).toBeNull();
    expect(screen.getByText("新人")).toBeTruthy();
  });

  it("「账户与空间」这一行仍然指向设置页——头像槽位以前就是干这个的", () => {
    signIn({ email: "asklins@example.com", displayName: null });
    stubProfile({ displayName: null, avatarUrl: null });
    const onOpenAccount = vi.fn();
    render(<HudAccountCard onOpenAccount={onOpenAccount} />);

    fireEvent.click(screen.getByRole("button", { name: /^账户与空间/ }));

    expect(onOpenAccount).toHaveBeenCalledOnce();
  });

  it("说清楚退出删不掉什么：不报数字，也不许诺别的设备的登录", () => {
    signIn({ email: "asklins@example.com", displayName: null });
    stubProfile({ displayName: null, avatarUrl: null });
    render(<HudAccountCard onOpenAccount={() => {}} />);

    expect(screen.getByText(/退出不会删除任何学习记录/).textContent).toContain("其他设备");
  });
});
