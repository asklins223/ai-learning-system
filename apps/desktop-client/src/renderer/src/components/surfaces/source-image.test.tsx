// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSourceImage } from "./source-image";

/**
 * 这张测试守的是"站内图片怎么到了 `<img>` 上"。
 *
 * 渲染层的 origin 是 `ailearn-app://`，正文里的 `/api/uploads/…` 是相对路径，
 * 直接交给 `<img>` 只会落到应用包内；所以它必须经 main 的字节通道换成 blob URL。
 * 站外地址则相反：原样交给 `<img>`，不该白白多一次 IPC。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

function objectKeyFor(imageId: string): string {
  return `${workspaceId}/sources/${sourceId}/${imageId}.png`;
}

function imageUrlFor(imageId: string): string {
  return `/api/uploads/${objectKeyFor(imageId)}`;
}

const imageIds = {
  ready: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cached: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  failed: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function Harness({ url }: { readonly url: string }) {
  const { state, retry } = useSourceImage(url, 9);
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      {state.status === "ready" || state.status === "external" ? (
        <img
          data-testid="image"
          src={state.src}
          alt=""
          onError={state.status === "ready" ? retry : undefined}
        />
      ) : null}
    </div>
  );
}

function stubGetImage(implementation: (objectKey: string) => unknown) {
  const getImage = vi.fn(async (input: unknown) => {
    const { request } = input as { readonly request: { readonly objectKey: string } };
    return implementation(request.objectKey);
  });
  window.ailearn = { source: { getImage } } as unknown as typeof window.ailearn;
  return getImage;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:mock-${blob.size}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSourceImage", () => {
  it("turns an in-app upload path into a blob URL through the main-process channel", async () => {
    const objectKey = objectKeyFor(imageIds.ready);
    const getImage = stubGetImage(() => ({
      ok: true,
      workspaceEpoch: 9,
      data: { version: 1, mimeType: "image/png", imageBase64: "iVBORw0KGgo=", byteLength: 8 },
    }));

    const view = render(<Harness url={imageUrlFor(imageIds.ready)} />);
    expect(view.getByTestId("status").textContent).toBe("loading");

    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("ready"));
    expect(view.getByTestId("image").getAttribute("src")).toBe("blob:mock-8");
    expect(getImage).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ workspaceEpoch: 9 }),
        request: { version: 1, objectKey },
      }),
    );
  });

  it("fetches each in-app image once and reuses the cached blob URL", async () => {
    const getImage = stubGetImage(() => ({
      ok: true,
      workspaceEpoch: 9,
      data: { version: 1, mimeType: "image/png", imageBase64: "iVBORw0KGgo=", byteLength: 8 },
    }));

    const view = render(<Harness url={imageUrlFor(imageIds.cached)} />);
    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("ready"));
    // 重新挂载同一张图（翻页回看）不该再来一次字节请求。
    view.unmount();
    const again = render(<Harness url={imageUrlFor(imageIds.cached)} />);
    await waitFor(() => expect(again.getByTestId("status").textContent).toBe("ready"));

    expect(getImage).toHaveBeenCalledTimes(1);
  });

  it("leaves a foreign http(s) image to the renderer without touching the channel", async () => {
    const getImage = stubGetImage(() => {
      throw new Error("external images must not go through the byte channel");
    });

    const view = render(<Harness url="https://i0.hdslb.com/bfs/article/a.png" />);

    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("external"));
    expect(view.getByTestId("image").getAttribute("src")).toBe("https://i0.hdslb.com/bfs/article/a.png");
    expect(getImage).not.toHaveBeenCalled();
  });

  it("degrades to unavailable when the bytes cannot be fetched", async () => {
    stubGetImage(() => ({ ok: false, error: { code: "not_found", retry: "never", safeMessageKey: "x" } }));

    const view = render(<Harness url={imageUrlFor(imageIds.failed)} />);

    await waitFor(() => expect(view.getByTestId("status").textContent).toBe("unavailable"));
    expect(view.queryByTestId("image")).toBeNull();
  });
});
