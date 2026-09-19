// Verify the focused-region cleanup:
//   1. clean reload → wide, no strip;
//   2. focus 休息角 → strip shows; measure the strip vs the bottom-left task island;
//   3. open a feature page and come back → the strip must be gone (zone back to wide);
//   4. Escape must still leave a focused region (no regression).
import { WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = ".impeccable/audit-2026-09-19";
await mkdir(OUT, { recursive: true });

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let seq = 0;
const pend = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  seq += 1; pend.set(seq, res); ws.send(JSON.stringify({ id: seq, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr, timeout = 8000) => {
  const reply = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeout).then(() => null),
  ]);
  if (!reply) return "TIMEOUT";
  if (reply.result?.exceptionDetails) return "EXC" + JSON.stringify(reply.result.exceptionDetails).slice(0, 200);
  return reply.result?.result?.value;
};

await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.enable");
await send("Page.reload");
await sleep(9000);
await send("Page.bringToFront");
await sleep(1200);

const PROBE = [
  "JSON.stringify((() => {",
  "  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();",
  "    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };",
  "  const q = (s) => document.querySelector(s);",
  "  const strip = q('.home-v2-region-menu');",
  "  const island = q('.home-v2-hud');",
  "  const overlap = (() => { if (!strip || !island) return null;",
  "    const a = strip.getBoundingClientRect(), b = island.getBoundingClientRect();",
  "    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);",
  "    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);",
  "    return ox > 0 && oy > 0 ? `${Math.round(ox)}x${Math.round(oy)}` : null; })();",
  "  return { zone: q('.home-v2-objects')?.dataset.activeZone ?? null, strip: r(strip), island: r(island),",
  "    stripOverlapsIsland: overlap, hotspots: document.querySelectorAll('.home-v2-object').length };",
  "})())",
].join("\n");

let failures = 0;
const check = (ok, label, extra) => {
  if (!ok) failures += 1;
  console.log(` ${ok ? " ok " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
};

const state = async () => {
  const raw = await ev(PROBE);
  try { return JSON.parse(raw); } catch { return { raw }; }
};
const shot = async (name) => {
  const reply = await send("Page.captureScreenshot", { format: "png" });
  if (reply?.result?.data) await writeFile(`${OUT}/${name}.png`, Buffer.from(reply.result.data, "base64"));
};
const clickId = (id) => ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return 'MISSING'; el.click(); return 'ok'; })()`);
const clickRail = (label) => ev(`(() => { const b = [...document.querySelectorAll('.hud-rail button')].find((x) => (x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(label)})); if (!b) return 'MISSING'; b.click(); return 'ok'; })()`);

const a = await state();
check(a.zone === "wide" && a.strip === null, "1 干净重载：房间总览、无签条", `zone=${a.zone}`);

await clickId("home-v2-object-rest-cushion");
await sleep(1000);
const b = await state();
check(b.zone === "rest" && b.strip !== null, "2 聚焦休息角：签条出现", `zone=${b.zone} strip=${JSON.stringify(b.strip)}`);
console.log(`     签条与任务岛(${JSON.stringify(b.island)}) 重叠:`, b.stripOverlapsIsland ?? "无");
await shot("fix-region-focused");

// Leave for a page through one of the region's own features, then come back.
const feature = await ev(`(() => { const b = document.querySelector('.home-v2-region-menu__features button'); if (!b) return 'MISSING'; const t = b.innerText.replace(/\\s+/g, ' ').slice(0, 20); b.click(); return t; })()`);
console.log(`     点功能：${feature}`);
await sleep(2500);
await clickRail("首页");
await sleep(1800);
const c = await state();
check(c.zone === "wide" && c.strip === null, "3 往返页面后：签条已收、回到总览", `zone=${c.zone}`);
await shot("fix-region-after-return");

// Escape must still leave a focused region.
await clickId("home-v2-object-window-stars");
await sleep(900);
const d = await state();
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await sleep(900);
const e = await state();
check(d.zone === "window" && e.zone === "wide", "4 Esc 仍能退出区域聚焦", `${d.zone} → ${e.zone}`);

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
