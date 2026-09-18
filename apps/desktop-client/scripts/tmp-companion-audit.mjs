// Per-page companion audit v2: verified navigation, geometry sampling, and a
// hide/show pixel diff that measures the character's real visible box.
import { WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = ".impeccable/companion-audit";
await mkdir(OUT, { recursive: true });
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
const ev = async (expr, timeout = 8000) => {
  const reply = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeout).then(() => null),
  ]);
  if (!reply) return "TIMEOUT";
  if (reply.result?.exceptionDetails) return "EXC:" + JSON.stringify(reply.result.exceptionDetails).slice(0, 200);
  return reply.result?.result?.value;
};

const pageId = () => ev(`document.querySelector('.companion-presence')?.dataset.surface ?? 'home'`);

const geometry = () => ev(`(() => {
  const round = (n) => Math.round(n);
  const root = document.querySelector('.companion-presence');
  const anchor = document.querySelector('.companion-scene-anchor');
  const visual = document.querySelector('.companion-visual-shell');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom), w: round(r.width), h: round(r.height) }; };
  return JSON.stringify({
    page: root?.dataset.surface ?? 'home',
    hudPage: document.querySelector('.desktop-app')?.dataset.hudPage ?? null,
    vw: innerWidth, vh: innerHeight,
    anchor: rect(anchor),
    visual: rect(visual),
  });
})()`);

const shot = async (name) => {
  // An occluded Electron window reports visibilityState=hidden and stops
  // compositing, so captureScreenshot would return an older page's frame.
  const reply = await send("Page.captureScreenshot", { format: "png" });
  if (reply?.result?.data) { await writeFile(`${OUT}/${name}.png`, Buffer.from(reply.result.data, "base64")); return true; }
  return false;
};

// Keep the page compositing even while the window sits behind the terminal.
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.bringToFront");
await sleep(600);

// Measure the companion's real visible box by diffing clip screenshots with the
// character hidden. Returns CSS-pixel bbox of changed pixels.
const measureCharacter = async () => {
  const bounds = await ev(`(() => {
    const a = document.querySelector('.companion-scene-anchor');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return JSON.stringify({ x: Math.max(0, Math.floor(r.left - 80)), y: Math.max(0, Math.floor(r.top - 80)),
      w: Math.min(innerWidth, Math.ceil(r.right + 80)) - Math.max(0, Math.floor(r.left - 80)),
      h: Math.min(innerHeight, Math.ceil(r.bottom + 80)) - Math.max(0, Math.floor(r.top - 80)) });
  })()`);
  if (typeof bounds !== "string") return null;
  const clip = JSON.parse(bounds);
  if (clip.w <= 0 || clip.h <= 0) return null;
  const withChar = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
  await ev(`(() => { const a = document.querySelector('.companion-visual-shell'); if (a) a.style.visibility = 'hidden'; return 1; })()`);
  await sleep(250);
  const withoutChar = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
  await ev(`(() => { const a = document.querySelector('.companion-visual-shell'); if (a) a.style.visibility = ''; return 1; })()`);
  await sleep(200);
  const a = withChar?.result?.data, b = withoutChar?.result?.data;
  if (!a || !b) return null;
  return ev(`(async () => {
    const load = async (b64) => { const blob = await (await fetch('data:image/png;base64,' + b64)).blob(); return await createImageBitmap(blob); };
    const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
    const c = new OffscreenCanvas(ia.width, ia.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, ia.width, ia.height).data;
    ctx.clearRect(0, 0, ia.width, ia.height);
    ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, ia.width, ib.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, changed = 0;
    for (let y = 0; y < ia.height; y += 1) {
      for (let x = 0; x < ia.width; x += 1) {
        const i = (y * ia.width + x) * 4;
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]) + Math.abs(da[i+3] - db[i+3]);
        if (d > 24) { changed += 1; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
      }
    }
    if (changed < 50) return JSON.stringify({ changed, box: null });
    return JSON.stringify({ changed, box: { l: minX, t: minY, r: maxX, b: maxY, w: maxX - minX, h: maxY - minY },
      cssBox: { l: ${clip.x} + minX, t: ${clip.y} + minY, r: ${clip.x} + maxX, b: ${clip.y} + maxY, w: maxX - minX, h: maxY - minY } });
  })()`, 15000);
};

const clickChip = (label) => ev(`document.querySelector('.hud-rail .nav-chip[aria-label="${label}"]')?.click()`);

const visit = async (label, name) => {
  const before = await pageId();
  await clickChip(label);
  let now = before;
  for (let i = 0; i < 12; i += 1) {
    await sleep(600);
    now = await pageId();
    if (now !== before) break;
  }
  await sleep(1200);
  const geo = JSON.parse(await geometry());
  const measured = await measureCharacter();
  await shot(name);
  const line = { intended: name, ...geo, character: measured };
  console.log(`--- ${name}: page=${geo.page} hudPage=${geo.hudPage}`);
  console.log("   anchor:", JSON.stringify(geo.anchor), " margins R/B:", geo.vw - geo.anchor.r, "/", geo.vh - geo.anchor.b);
  console.log("   character:", measured);
  return line;
};

const report = {};
report["01-home"] = await visit("首页", "01-home");
report["05-sources"] = await visit("来源", "05-sources");
report["07-notes"] = await visit("笔记", "07-notes");
report["10-goals"] = await visit("理解", "10-goals");
report["19-graph"] = await visit("星图", "19-graph");
report["14-today"] = await visit("今日学习", "14-today");
report["15-queue"] = await visit("复习", "15-queue");
report["18-search"] = await visit("查找", "18-search");
report["20-companion"] = await visit("伴星", "20-companion");
report["21-settings"] = await visit("设置", "21-settings");

await writeFile(`${OUT}/report-v2.json`, JSON.stringify(report, null, 2));
console.log("saved", OUT);
ws.close();
process.exit(0);
