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
 * 视图对象由这个 hook **按内容**留住身份（下面 `cacheRef` 那段），调用方 memo 不 memo
 * 都不会造成反复推送；memo 过的一方走的是身份相同的快路径。
 */
export function usePageReadableView(view: PageReadableV1 | null) {
  const publish = useRoomStore((state) => state.publishPageReadableView);
  const retract = useRoomStore((state) => state.retractPageReadableView);
  const tokenRef = useRef(crypto.randomUUID());
  /**
   * 按**内容**留住同一个对象（`useMemo` 的依赖表在这里不可行：设置中心那种一屏有几十个
   * 状态值，漏一个就是一条永不喊的脏读数）。
   *
   * 为什么非留住不可：会话侧 `companion-chat-session.tsx:581` 订阅了这个槽位，
   * 并把 `pageReadableView` 放进推送载荷的依赖表。对象身份每次渲染都换 ⇒ 每次渲染
   * 都向服务端推一次。store 那一层的短路（`room-store.ts:557`）比的是 token＋内容，
   * 认得出内容没变，但它救不了**调用方这边**的 effect 反复 retract／publish。
   */
  const cacheRef = useRef<{ readonly serialized: string; readonly value: PageReadableV1 | null } | null>(null);
  const serialized = JSON.stringify(view);
  if (cacheRef.current?.serialized !== serialized) cacheRef.current = { serialized, value: view };
  const stable = cacheRef.current.value;

  useEffect(() => {
    if (!stable) return undefined;
    // 超预算/形状不对就在这里挡掉，并且**喊出来**：往下的每一层都是静默的——
    // 推送那一句是 `.catch(() => undefined)`（companion-chat-session.tsx:559），
    // 服务端 strict schema 会整份拒绝，工具那端只会报"这一页没有可读内容"。
    // 一条登记错的视图因此完全不会红，症状只是"她偶尔读不到这一页"。
    const parsed = pageReadableV1Schema.safeParse(stable);
    if (!parsed.success) {
      console.error("[page-readable] 这一页登记的可读内容不合合同，已不发布", parsed.error.issues, stable);
      return undefined;
    }
    publish(tokenRef.current, parsed.data);
    return () => retract(tokenRef.current);
  }, [publish, retract, stable]);
}
