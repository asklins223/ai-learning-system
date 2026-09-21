// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  hasForeignModal,
  isCompanionOwnedModal,
  isModalElement,
} from "./companion-modal-ownership";

/**
 * 实机撞到的那条形状，一比一搬进 jsdom：
 * 伴星抽屉（`.companion-history companion-chat`）里的一条 AI 图片消息，点开之后
 * 灯箱根元素是 `role=dialog aria-modal=true`，而**它自己不是** `.companion-chat`。
 * 旧判定只看元素自身的类名和 `.companion-presence` 祖先，于是这个灯箱被算成"外部模态"
 * → 存在层立刻 `setMode("closed")` → 抽屉连同灯箱一起卸载
 * （用户报的现象："点 AI 返回的图片，窗口自己关了并回到首页"）。
 */
const LIGHTBOX = `<div class="image-lightbox" role="dialog" aria-modal="true" aria-label="放大查看"><img src="x.png"></div>`;

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("伴星存在层的模态归属判定", () => {
  it("抽屉里自己点的图片灯箱不算外部模态", () => {
    mount(
      `<div class="companion-presence"><aside class="companion-history companion-chat" role="dialog" aria-modal="true">${LIGHTBOX}</aside></div>`,
    );
    expect(hasForeignModal(document)).toBe(false);
  });

  it("抽屉没套在存在层里时，抽屉内的对话框同样不算外部", () => {
    // 首页 V2 与房间座位两种挂法下祖先链不同，所以抽屉自身这一层也必须认。
    mount(`<aside class="companion-history companion-chat">${LIGHTBOX}</aside>`);
    expect(hasForeignModal(document)).toBe(false);
  });

  it("页面上别人的模态仍然算外部（规则不能被改成永不触发）", () => {
    mount(`<section class="surface"><div role="dialog" aria-modal="true" class="note-share-dialog">导出</div></section>`);
    expect(hasForeignModal(document)).toBe(true);
    mount(`<dialog open>确认删除</dialog>`);
    expect(hasForeignModal(document)).toBe(true);
  });

  it("存在层里的伴星确认气泡不算外部", () => {
    mount(`<div class="companion-presence"><div role="alertdialog" aria-modal="true">确认这个动作？</div></div>`);
    expect(hasForeignModal(document)).toBe(false);
  });

  it("role=dialog 但没有 aria-modal=true 的不算模态", () => {
    mount(`<div role="dialog" class="companion-inline-panel">内联面板</div>`);
    const element = document.querySelector(".companion-inline-panel")!;
    expect(isModalElement(element)).toBe(false);
    expect(hasForeignModal(document)).toBe(false);
  });

  it("灯箱自身既是模态、也归属伴星（两条都得成立，否则测试没在测这件事）", () => {
    mount(`<div class="companion-presence">${LIGHTBOX}</div>`);
    const lightbox = document.querySelector(".image-lightbox")!;
    expect(isModalElement(lightbox)).toBe(true);
    expect(isCompanionOwnedModal(lightbox)).toBe(true);
  });

  it("旧判定的漏法被钉住：抽屉不在存在层里时，只看自身类名会把灯箱当成外部", () => {
    mount(`<aside class="companion-history companion-chat">${LIGHTBOX}</aside>`);
    const lightbox = document.querySelector(".image-lightbox")!;
    // 旧规则只有两个豁免：元素自身类名是 companion-chat、或有 .companion-presence 祖先。
    // 灯箱两条都不满足 → 被当成外部模态 → 伴星自己把抽屉关掉。
    const legacyExempt =
      lightbox.classList.contains("companion-chat") ||
      Boolean(lightbox.closest(".companion-presence"));
    expect(legacyExempt).toBe(false);
    expect(isCompanionOwnedModal(lightbox)).toBe(true);
  });
});
