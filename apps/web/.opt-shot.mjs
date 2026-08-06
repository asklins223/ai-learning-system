// 当前 v1 轮播视觉快照（优化前评估用，验证后删除）
import { chromium } from "@playwright/test";
const ORIGIN = "http://127.0.0.1:3100";
const API = "http://127.0.0.1:4000";
const CREATED = "2026-08-01T00:00:00.000Z";
const S1 = "set-00000000-0000-0000-0000-000000000001";
const MOCK_SETS = [
  { id: S1, workspaceId: "ws-1", noteId: "note-1", noteVersionId: "nv-1", generationRunId: "run-1", status: "active", title: "量子力学基础", summary: "波函数、观测与不确定性原理的入门梳理。", coverageReport: null, createdAt: CREATED, activatedAt: CREATED, supersededAt: null, cardCount: 4, sectionCardCount: 3, overviewCardId: "c-1" },
  { id: "set-00000000-0000-0000-0000-000000000002", workspaceId: "ws-1", noteId: "note-1", noteVersionId: "nv-2", generationRunId: "run-2", status: "superseded", title: "旧版量子力学", summary: "已被新版本替代的早期整理。", coverageReport: null, createdAt: CREATED, activatedAt: CREATED, supersededAt: CREATED, cardCount: 3, sectionCardCount: 2, overviewCardId: "c-11" },
  { id: "set-00000000-0000-0000-0000-000000000003", workspaceId: "ws-1", noteId: "note-2", noteVersionId: "nv-3", generationRunId: "run-3", status: "archived", title: "归档卡组", summary: "已归档的临时整理。", coverageReport: null, createdAt: CREATED, activatedAt: CREATED, supersededAt: null, cardCount: 2, sectionCardCount: 1, overviewCardId: "c-21" },
];
function mem(id, title, scope, ordinal, kp = 2) { return { card: { id, noteVersionId: "nv-1", workspaceId: "ws-1", status: "active", schemaJson: { title, summary: `${title} 的说明。` }, artifactId: null, createdAt: CREATED, cardSetId: S1, scope, ordinal }, keyPoints: Array.from({ length: kp }, (_, i) => ({ id: `${id}-kp-${i}`, cardId: id, ordinal: i, claim: `要点 ${i + 1}`, quoteText: null, segmentRef: null })) }; }
const MEMBERS = { [S1]: [mem("c-1", "量子力学总览", "overview", 0, 3), mem("c-2", "波函数与概率幅", "section", 1), mem("c-3", "不确定性原理", "section", 2), mem("c-4", "观测与坍缩", "section", 3, 1)] };
const browser = await chromium.launch();
async function makeContext(viewport) {
  const context = await browser.newContext({ viewport });
  const email = `opt-${Date.now()}@test.local`;
  const reg = await fetch(`${API}/auth/register-personal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Verify12345!", displayName: "Opt" }) });
  for (const c of reg.headers.getSetCookie()) { const [p] = c.split(";"); const eq = p.indexOf("="); await context.addCookies([{ name: p.slice(0, eq), value: p.slice(eq + 1), url: ORIGIN }]); }
  await context.addInitScript(({ MOCK_SETS, MEMBERS }) => {
    const origFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/card-sets")) {
        const cardsMatch = url.match(/\/api\/card-sets\/([^/?]+)\/cards/);
        if (cardsMatch) return new Response(JSON.stringify({ cardSetId: cardsMatch[1], items: MEMBERS[cardsMatch[1]] ?? [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
        const detailMatch = url.match(/\/api\/card-sets\/([^/?]+)$/);
        if (detailMatch) { const s = MOCK_SETS.find((x) => x.id === detailMatch[1]); return s ? new Response(JSON.stringify({ cardSet: s, cards: MEMBERS[detailMatch[1]] ?? [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }) : new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } }); }
        return new Response(JSON.stringify({ items: MOCK_SETS, nextCursor: null, total: MOCK_SETS.length }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(input, init);
    };
  }, { MOCK_SETS, MEMBERS });
  return context;
}
const page = await (await makeContext({ width: 1440, height: 900 })).newPage();
await page.goto(`${ORIGIN}/cards`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/opt-carousel.png" });
// 封面 hover 态
const cb = await page.locator('[data-ui="deck-cover"]').nth(0).boundingBox();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/opt-carousel-hover.png" });
// 展开态
await page.locator('[data-ui="deck-cover"]').nth(0).click();
await page.waitForTimeout(900);
await page.screenshot({ path: "/tmp/opt-expanded.png", fullPage: true });
const mob = await (await makeContext({ width: 390, height: 844 })).newPage();
await mob.goto(`${ORIGIN}/cards`, { waitUntil: "networkidle" });
await mob.waitForTimeout(1000);
await mob.locator('[data-ui="deck-cover"]').nth(0).click();
await mob.waitForTimeout(700);
await mob.screenshot({ path: "/tmp/opt-mobile.png" });
await browser.close();
