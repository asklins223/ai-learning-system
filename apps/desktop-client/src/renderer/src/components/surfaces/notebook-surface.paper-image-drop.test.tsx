// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTE_PAPER_IMAGE_DROP_ATTR } from "../../app/source-intake";
import { noteDocResult } from "../../test-support/note-doc-fixtures";
import { useRoomStore } from "../../app/room-store";
import { NotebookSurface } from "./notebook-surface";

/**
 * 往笔记里插图片这条拖放路的归属。
 *
 * 缺陷原样：从文件管理器把截图拖进笔记编辑页，指针只要先扫过工具条或页边，
 * 全局"收进来源库"那层就把这一下抢走，回一句"暂不解析这张图"。修好后纸面自己
 * 认领整份图片——正文里那一块仍归编辑器，纸面只补它够不着的那一圈。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const UPLOADED_URL = "/api/uploads/2f1c9a70-1111-4111-8111-111111111111.png";

function stubGateway(mode: "edit" | "read") {
  const uploads: unknown[] = [];
  const gateway = {
    contract: { enabledRoutes: ["note.detail"] },
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          primaryFocus: {
            state: "data",
            data: {
              objective: {
                content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null },
                personal: { lastCanonicalAt: null },
                sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
              },
            },
          },
        },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "测试笔记",
          sourceId: null,
          currentVersionId: "v-1",
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "hash-1",
            blocks: [{ ordinal: 1, type: "paragraph", content: "第一段内容。" }],
          },
        },
      })),
      doc: {
        state: vi.fn(async () => noteDocResult()),
        syncUpdate: vi.fn(async () => ({
          ok: true as const,
          workspaceEpoch: 1,
          data: { via: "uploaded" as const, revision: 1, savedAt: new Date().toISOString() },
        })),
        presence: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { shared: false } })),
      },
      // 桩照真合同返回：正文里落的就是这个站内地址。
      uploadImage: vi.fn(async (input: unknown) => {
        uploads.push(input);
        return {
          ok: true as const,
          workspaceEpoch: 1,
          data: {
            version: 1,
            url: UPLOADED_URL,
            byteLength: 1_240,
            mimeType: "image/png",
            width: 1200,
            height: 700,
          },
        };
      }),
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed" },
          featureAvailability: {
            card_generation_v2: { state: "disabled" },
            companion_dialogue_v1: { state: "disabled" },
          },
        },
      })),
    },
    source: {
      get: vi.fn(async () => ({
        ok: false as const,
        error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
      })),
      getImage: vi.fn(async () => ({
        ok: false as const,
        error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
      })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode } });
  return { uploads };
}

async function renderNote(mode: "edit" | "read") {
  const stub = stubGateway(mode);
  vi.useFakeTimers();
  render(<NotebookSurface />);
  // 数据加载与 Milkdown 的异步创建都要靠推进假时钟来冲洗微任务。
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(100);
  return stub;
}

const pngTransfer = () => ({
  files: [new File(["\x89PNG\r\n\x1a\n"], "截屏.png", { type: "image/png" })],
  types: ["Files"],
  getData: () => "",
  dropEffect: "copy" as const,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useRoomStore.setState({ activeNoteRef: null });
});

describe("NotebookSurface · 纸面上的图片拖放", () => {
  it("编辑态的纸面认领图片归属", async () => {
    await renderNote("edit");
    const paper = document.querySelector(`[${NOTE_PAPER_IMAGE_DROP_ATTR}]`);
    expect(paper).toBeTruthy();
    expect(paper?.classList.contains("notebook")).toBe(true);
  });

  it("阅读态不认领：那一篇不能往里写东西", async () => {
    await renderNote("read");
    expect(document.querySelector(`[${NOTE_PAPER_IMAGE_DROP_ATTR}]`)).toBeNull();
  });

  it("落在正文之外的纸面上，这张图进的是这一篇笔记", async () => {
    const { uploads } = await renderNote("edit");
    const page = document.querySelector(".editor-copy");
    expect(page).toBeTruthy();
    expect(page?.closest(".ProseMirror")).toBeNull();

    fireEvent.drop(page!, { dataTransfer: pngTransfer() });

    // 正文里当场落下占位图，上传状态列点名这张文件。
    expect(document.querySelector('.ProseMirror img[src^="uploading:"]')).toBeTruthy();
    expect(screen.getByText("截屏.png")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(300);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      noteId: NOTE_ID,
      request: { fileName: "截屏.png", mimeType: "image/png" },
    });
  });

  it("混进一份非图片文件，纸面不认领", async () => {
    const { uploads } = await renderNote("edit");
    const page = document.querySelector(".editor-copy");
    expect(page).toBeTruthy();

    // 整份都是图片才叫"往正文里放图"；混进别的文件就交回全局采集器逐份说清去向。
    fireEvent.drop(page!, {
      dataTransfer: {
        files: [
          new File(["\x89PNG\r\n\x1a\n"], "截屏.png", { type: "image/png" }),
          new File(["# 正文"], "note.md", { type: "text/markdown" }),
        ],
        types: ["Files"],
        getData: () => "",
        dropEffect: "copy" as const,
      },
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(uploads).toHaveLength(0);
  });

  it("正文里那一下轮不到纸面兜底", async () => {
    const { uploads } = await renderNote("edit");
    /**
     * jsdom 没实现 `document.elementFromPoint`，而 ProseMirror 的 `posAtCoords` 起手
     * 就调它：不补这一下，往正文里派发 drop 得到的是未捕获异常（用例照样绿，
     * 只在摘要里留一个 `Errors` 段）。补成真浏览器的语义——那个点上没有元素就是 null。
     */
    document.elementFromPoint = () => null;
    const body = document.querySelector(".ProseMirror[contenteditable='true']");
    expect(body).toBeTruthy();

    // 这条钉的是纸面兜底的让路条件：落点在正文里就一个字也不碰。摘掉
    // `closest(".ProseMirror")` 那道判断，这里就会多出一次上传。
    // 编辑器自己那一腿（一次松手只插一张图）在真窗口里量，见审计 F53。
    fireEvent.drop(body!, { dataTransfer: pngTransfer() });
    await vi.advanceTimersByTimeAsync(300);

    expect(uploads).toHaveLength(0);
    expect(document.querySelector('.ProseMirror img[src^="uploading:"]')).toBeNull();
  });
});
