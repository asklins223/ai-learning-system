/**
 * 「页面里弹了别人的模态 → 伴星把自己收起来」这条规则**算谁家的模态**。
 *
 * 独立成模块只为可测：判定住在 `CompanionPresence` 里，而那个组件带着 Live2D/pixi，
 * 在 jsdom 里挂起来代价极高，于是这条规则此前一次也没被测过——代价就是实机撞到的
 * 那个 bug（用户 2026-09-21 报「在对话记录里点 AI 返回的图片，窗口自己关了并回到首页」）：
 * 伴星**自己**图片灯箱的根元素就是 `role="dialog" aria-modal="true"`，
 * 于是它被判成外部模态 → `externalModalOpen` 置真 → 交互层整层关闭 →
 * 抽屉（灯箱住在抽屉里）连同灯箱一起被卸载。用户看到的就是"点一下图，界面没了"。
 *
 * 归属只按 DOM 事实判：**是不是在伴星自己的层里**（`.companion-presence`）
 * 或**是不是在伴星抽屉里**（`.companion-chat` / `.companion-history`，抽屉根同时带这两个类）。
 * 不看类名白名单，因为伴星 surface 里的对话框还会再加。
 */
const COMPANION_OWNED_SURFACE_SELECTOR = ".companion-presence, .companion-chat, .companion-history";

/** 这个元素本身是不是一个模态（与存在层当初扫描的选择器同一形状）。 */
export function isModalElement(element: Element): boolean {
  if (element.matches("dialog[open]")) return true;
  return (
    element.matches("[role='dialog'], [role='alertdialog']") &&
    element.getAttribute("aria-modal") === "true"
  );
}

/** 这个模态是不是伴星自己弹的（自己的一概不算"外部"）。 */
export function isCompanionOwnedModal(element: Element): boolean {
  // `data-companion-owned` 是给 portal 到 body 的全屏灯箱留的：一旦它挂在 body 上，
  // 祖先链里就没有任何伴星 surface 可认了（而"必须挂 body"见 image-viewer.tsx 的注释：
  // 抽屉的 animation fill-mode 让 fixed 后代只能铺满抽屉）。
  if (element.getAttribute("data-companion-owned") === "true") return true;
  return element.closest(COMPANION_OWNED_SURFACE_SELECTOR) !== null;
}

/** 存在层要的谓词：页面里存在**别人的**模态。 */
export function hasForeignModal(root: ParentNode): boolean {
  const candidates = root.querySelectorAll(
    "dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']",
  );
  for (const element of candidates) {
    if (isModalElement(element) && !isCompanionOwnedModal(element)) return true;
  }
  return false;
}
