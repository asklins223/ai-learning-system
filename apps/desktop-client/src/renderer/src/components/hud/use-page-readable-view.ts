import { useEffect, useRef } from "react";
import { pageReadableV1Schema, type PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "../../app/room-store";

/**
 * 把「这一页此刻显示给用户什么」登记进房间 store，供伴星通用读取（doc 37）。
 *
 * 与 `useHudPage` 同一套形状：页面自己发布、shell 侧统一消费。这两者必须成对存在——
 * `hudPage` 只说"在哪一页"，说不清那一页上正在发生什么（进度、计数器、列表里第几项）。
 *
 * 传 `null` 表示这一页没有可读内容，槽位让开：她读到的是"读不到"，而不是上一屏的残留。
 *
 * 视图对象应当由调用方 memo 化，但**不 memo 也不会成环**：store 侧按内容比对，
 * 相同内容直接返回原 state（zustand 的 `Object.is` 短路，不通知订阅者）。
 */
export function usePageReadableView(view: PageReadableV1 | null) {
  const publish = useRoomStore((state) => state.publishPageReadableView);
  const retract = useRoomStore((state) => state.retractPageReadableView);
  const tokenRef = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!view) return undefined;
    // 超预算/形状不对就在这里挡掉，并且**喊出来**：往下的每一层都是静默的——
    // 推送那一句是 `.catch(() => undefined)`（companion-chat-session.tsx:559），
    // 服务端 strict schema 会整份拒绝，工具那端只会报"这一页没有可读内容"。
    // 一条登记错的视图因此完全不会红，症状只是"她偶尔读不到这一页"。
    const parsed = pageReadableV1Schema.safeParse(view);
    if (!parsed.success) {
      console.error("[page-readable] 这一页登记的可读内容不合合同，已不发布", parsed.error.issues, view);
      return undefined;
    }
    publish(tokenRef.current, parsed.data);
    return () => retract(tokenRef.current);
  }, [publish, retract, view]);
}
