/**
 * 桌面协同传输的连接接线（4.3 建立，2026-09-21 补这一条）。
 *
 * 为什么值得单独测：`HocuspocusProvider` 只有在**它自己造 socket**时才 `manageSocket=true`，
 * 本文件传的是外部 `websocketProvider`，于是它既不 `attach()`（不把监听挂到 socket 上）
 * 也不 `connect()`（不发起握手）。表现不是报错，是"连接看起来建好了，永远没有内容"——
 * 一个字节都没收发过。服务端那侧的集测用的是服务端自己的连接，所以那条路一直绿着，
 * 桌面这一侧从建立到补这条测试为止从来没通过。
 */
import * as Y from "yjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ attach: 0, connect: 0, destroy: 0, wsDestroy: 0 }));

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProviderWebsocket: class {
    connect() {
      calls.connect += 1;
    }
    destroy() {
      calls.wsDestroy += 1;
    }
    on() {}
  },
  HocuspocusProvider: class {
    authorizedScope = "read-write";
    awareness = { getStates: () => new Map(), on: () => undefined, setLocalState: () => undefined };
    on() {}
    attach() {
      calls.attach += 1;
    }
    destroy() {
      calls.destroy += 1;
    }
  },
}));

const { createHocuspocusNoteDocTransport } = await import("./note-doc-transport.ts");

const open = (documentName: string) => createHocuspocusNoteDocTransport()({
  url: "ws://127.0.0.1:4000/note-doc",
  documentName,
  token: "token-from-main-process",
  onEvent: () => undefined,
});

describe("note-doc 传输的连接接线", () => {
  beforeEach(() => {
    calls.attach = 0;
    calls.connect = 0;
    calls.destroy = 0;
    calls.wsDestroy = 0;
  });

  it("外部 socket 也要 attach + connect，否则一个字节都收不到", () => {
    const handle = open("note:11111111-1111-4111-8111-111111111111");
    expect(calls.attach, "provider 没把监听挂到外部 socket 上").toBe(1);
    expect(calls.connect, "没人发起握手：连接永远不会建立").toBe(1);
    handle.close();
  });

  it("关闭时两条出口都收掉（provider 不带 socket，destroy 不会替我关连接）", () => {
    const handle = open("note:22222222-1111-4111-8111-111111111111");
    handle.close();
    expect(calls.destroy).toBe(1);
    expect(calls.wsDestroy).toBe(1);
    // 关完再 close 不该重复拆（stop 之后迟到的帧必须丢掉，这里同一半）
    handle.close();
    expect(calls.destroy).toBe(1);
  });

  it("本机提交产出一条增量；远端来源已登记，不会被当成自己的再发回去", () => {
    const handle = open("note:33333333-1111-4111-8111-111111111111");
    // 界面交的是渲染进程那份文档产生的一条增量，不是 blocks。
    const local = new Y.Doc();
    local.getMap("probe").set("k", "本机打的一句");
    const update = handle.applyLocal(Buffer.from(Y.encodeStateAsUpdate(local)).toString("base64"));
    expect(typeof update).toBe("string");
    // 同一条增量再交一次不该产出增量：这是"未改动"回执的依据。
    expect(handle.applyLocal(Buffer.from(Y.encodeStateAsUpdate(local)).toString("base64"))).toBeNull();
    handle.close();
  });
});
