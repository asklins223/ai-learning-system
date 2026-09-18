// Timeline probe: after each navigation, watch hudPage / surface / anchor
// position to catch a stale-seat jump, and report each page's content panel.
import { WebSocket } from "ws";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.on("open", resolve); });
let seq = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  seq += 1; pending.set(seq, res); ws.send(JSON.stringify({ id: seq, method, params }));
});
const ev = async (expr, timeout = 6000) => {
  const reply = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeout).then(() => null),
  ]);
  if (!reply) return "TIMEOUT";
  if (reply.result?.exceptionDetails) return "EXC:" + JSON.stringify(reply.result.exceptionDetails).slice(0, 160);
  return reply.result?.result?.value;
};
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.bringToFront");

const probe = () => ev(`(() => {
  const a = document.querySelector('.companion-scene-anchor');
  const m = a ? new DOMMatrixReadOnly(getComputedStyle(a).transform) : null;
  return JSON.stringify({
    sf: document.querySelector('.companion-presence')?.dataset.surface,
    hp: document.querySelector('.desktop-app')?.dataset.hudPage ?? null,
    x: m ? Math.round(m.e) : null, y: m ? Math.round(m.f) : null,
  });
})()`);

const clickChip = async (label) => {
  const rect = await ev(`(() => { const b = document.querySelector('.hud-rail .nav-chip[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`);
  if (!rect || typeof rect !== "string") return false;
  const { x, y } = JSON.parse(rect);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  return true;
};

// Content panel candidates: whatever large box holds the page body.
const contentPanel = () => ev(`(() => {
  const round = (n) => Math.round(n);
  const cands = Array.from(document.querySelectorAll('.hud-page *'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 420 && r.height > 260 && r.top > 40 && r.left > 60; })
    .map((el) => { const r = el.getBoundingClientRect(); return { cls: (el.className || '').toString().slice(0, 60), l: round(r.left), r: round(r.right), t: round(r.top), b: round(r.bottom), area: r.width * r.height }; })
    .sort((a, b) => b.area - a.area).slice(0, 4);
  return JSON.stringify(cands);
})()`);

for (const label of ["设置", "今日学习", "星图", "笔记", "复习"]) {
  console.log("=== " + label);
  await clickChip(label);
  for (let i = 0; i < 8; i += 1) { await sleep(300); console.log("  t+" + ((i + 1) * 300) + "ms", await probe()); }
  console.log("  panels:", await contentPanel());
}
ws.close();
process.exit(0);
