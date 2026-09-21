// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRoomStore } from "../app/room-store";
import { SpaceSharingNotice } from "./space-sharing-notice";

/**
 * 「放入共享空间即视为可外发」这条裁决只在协作空间出现：个人空间里说它是噪音，
 * 说了"别人的伴星会读到"而空间里只有自己，反而让人怀疑是不是哪里露出了数据。
 */

afterEach(() => {
  cleanup();
  useRoomStore.getState().setSpaceIdentity(null);
});

describe("SpaceSharingNotice", () => {
  it("协作空间里说明资料与伴星读取的边界", () => {
    useRoomStore.getState().setSpaceIdentity({ name: "海岸研究室", role: "owner", isPersonal: false });
    render(<SpaceSharingNotice />);

    const line = screen.getByTestId("space-sharing-notice");
    expect(line.textContent).toContain("放进来的资料整个空间的人都能看到");
    expect(line.textContent).toContain("他们各自的 AI 使用同意");
  });

  it("个人空间不显示", () => {
    useRoomStore.getState().setSpaceIdentity({ name: "我的书房", role: "owner", isPersonal: true });
    render(<SpaceSharingNotice />);
    expect(screen.queryByTestId("space-sharing-notice")).toBeNull();
  });

  it("还没读到空间身份时不显示（不拿默认值猜一个边界给人看）", () => {
    render(<SpaceSharingNotice />);
    expect(screen.queryByTestId("space-sharing-notice")).toBeNull();
  });
});
