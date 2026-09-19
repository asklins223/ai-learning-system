// Companion HUD geometry gate. Two sections:
//   1. acceptance viewports (1440×810 / 1280×720 / 720×405 compact), home seat —
//      every panel stays inside the viewport, clear of the character, and the
//      compact settings panel can still reach its last control by scrolling;
//   2. every rail page — the panel and the control column must stay inside the
//      viewport whichever side the companion is seated on (a seat on the right
//      must not flip them off-screen).
// Exits non-zero on any failure.
import { WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = ".impeccable/companion-hud-audit";
await mkdir(OUT, { recursive: true });

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no CDP page target on :9222（先跑 npm run dev）");
  process.exit(1);
}
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
  if (reply.result?.exceptionDetails) return "EXC" + JSON.stringify(reply.result.exceptionDetails).slice(0, 160);
  return reply.result?.result?.value;
};

await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.bringToFront");
await sleep(300);

const PROBE = [
  "(() => {",
  "  const q = (s) => document.querySelector(s);",
  "  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();",
  "    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };",
  "  const panel = q('.companion-hud__panel');",
  "  const visual = q('.companion-visual-shell');",
  "  const controls = q('.companion-hud__controls');",
  "  const problems = [];",
  "  const check = (name, rect) => { if (!rect) return;",
  "    if (rect.l < 0) problems.push(name + ': 左溢出 ' + (-rect.l));",
  "    if (rect.r > innerWidth) problems.push(name + ': 右溢出 ' + (rect.r - innerWidth));",
  "    if (rect.t < 0) problems.push(name + ': 上溢出 ' + (-rect.t));",
  "    if (rect.b > innerHeight) problems.push(name + ': 下溢出 ' + (rect.b - innerHeight)); };",
  "  check('panel', r(panel)); check('controls', r(controls));",
  "  if (panel && visual) {",
  "    const a = panel.getBoundingClientRect(), b = visual.getBoundingClientRect();",
  "    if (!(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top)) problems.push('panel: 压住角色');",
  "  }",
  "  return JSON.stringify({ vw: innerWidth, vh: innerHeight, page: q('.desktop-app')?.dataset.hudPage,",
  "    policy: q('.companion-presence')?.dataset.policyMode, compLeft: q('.desktop-app')?.classList.contains('comp-left'),",
  "    panel: r(panel), controls: r(controls), visual: r(visual), problems });",
  "})()",
].join("\n");

const clickSel = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'MISSING'; el.click(); return 'ok'; })()`);
const shot = async (name) => {
  const reply = await send("Page.captureScreenshot", { format: "png" });
  if (reply?.result?.data) await writeFile(`${OUT}/${name}.png`, Buffer.from(reply.result.data, "base64"));
};

let failures = 0;
const report = (ok, label, extra) => {
  if (!ok) failures += 1;
  console.log(` ${ok ? " ok " : "FAIL"} ${label}${extra ? ` ${extra}` : ""}`);
};

// ── 1. 验收视口（首页座位） ────────────────────────────────────────────────
console.log("\n[1] 验收视口下的交互台面板");
for (const [w, h] of [[1440, 810], [1280, 720], [720, 405]]) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  }
  const label = `${w}x${h}`;
  await clickSel('.companion-hud__controls button[aria-label="更多功能"]');
  await sleep(450);
  const menu = JSON.parse(await ev(PROBE));
  report(menu.problems.length === 0, `${label} more`, JSON.stringify(menu.problems));

  await ev(`(() => { const b = [...document.querySelectorAll('.companion-hud__menu-index button')].find((x) => x.textContent.includes('快捷设置')); b?.click(); return 1; })()`);
  await sleep(450);
  const settings = JSON.parse(await ev(PROBE));
  const reach = await ev(`(() => { const p = document.querySelector('.companion-hud__panel'); if (!p) return null;
    p.scrollTop = p.scrollHeight;
    const last = [...p.querySelectorAll('button')].pop(); if (!last) return null;
    const b = last.getBoundingClientRect();
    return JSON.stringify({ text: last.textContent.trim().slice(0, 16), visible: b.bottom <= innerHeight && b.top >= 0 }); })()`);
  const reachable = reach ? JSON.parse(reach) : null;
  report(
    settings.problems.length === 0 && (!reachable || reachable.visible),
    `${label} settings`,
    `${JSON.stringify(settings.problems)} 末个控件 ${reachable?.text ?? "?"} 可见=${reachable?.visible}`,
  );
  await shot(`${label}-settings`);

  await clickSel('.companion-hud__panel header button[aria-label="关闭更多功能"]');
  await sleep(250);
  await clickSel('.companion-hud__controls button[aria-label="文字输入"]');
  await sleep(450);
  const composer = JSON.parse(await ev(PROBE));
  report(composer.problems.length === 0, `${label} composer`, JSON.stringify(composer.problems));
  await clickSel('.companion-hud__panel header button[aria-label="收起消息气泡"]');
  await sleep(250);
}
await send("Emulation.clearDeviceMetricsOverride");
await sleep(400);

// ── 2. 每个页面的座位方向 ────────────────────────────────────────────────
console.log("\n[2] 各页面座位下面板与控制列是否都在窗口内");
const rail = await ev(`JSON.stringify([...document.querySelectorAll('.hud-rail button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()))`);
const labels = JSON.parse(rail ?? "[]");
for (const label of labels) {
  const ok = await ev(`(() => { const b = [...document.querySelectorAll('.hud-rail button')].find((x) => (x.getAttribute('aria-label') || x.textContent).includes(${JSON.stringify(label)})); if (!b) return 'MISSING'; b.click(); return 'ok'; })()`);
  if (ok !== "ok") continue;
  await sleep(1300);
  await clickSel('.companion-hud__controls button[aria-label="更多功能"]');
  await sleep(500);
  const data = JSON.parse(await ev(PROBE));
  report(
    data.problems.length === 0,
    `${label} (page ${data.page ?? "?"}${data.compLeft ? " · 座位左" : ""})`,
    JSON.stringify(data.problems),
  );
  await ev(`(() => { const b = document.querySelector('.companion-hud__panel header button[aria-label="关闭更多功能"]'); if (b) b.click(); return 1; })()`);
  await sleep(200);
}

// 回到首页，别把实例留在某个任务页
await ev(`(() => { const b = [...document.querySelectorAll('.hud-rail button')].find((x) => (x.getAttribute('aria-label') || x.textContent).includes('首页')); b?.click(); return 1; })()`);
await sleep(900);

// ── 3. 交互台契约（2026-09-19 用户截图那一批） ────────────────────────────
// 纯图标小按钮 / 输入气泡头部不被截断 / 关掉原生拖拽手柄 / 语音失败要有反馈 /
// 快捷设置无原生控件、无「关闭伴星」。数值都来自真实 DOM，不依赖视觉判断。
console.log("\n[3] 交互台契约");
{
  const controls = await ev(`JSON.stringify([...document.querySelectorAll('.companion-hud__controls > button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim(), label: b.getAttribute('aria-label') }; }))`);
  const list = JSON.parse(controls ?? "[]");
  report(list.length === 3, "控制按钮仍是三枚", `${list.length}`);
  report(list.every((b) => b.w <= 46 && b.h <= 46), "按钮已缩小（≤46px）", list.map((b) => `${b.w}x${b.h}`).join(" "));
  report(list.every((b) => b.text === ""), "按钮内不再有文字标签", list.map((b) => b.label).join("/"));
}

await clickSel('.companion-hud__controls button[aria-label="文字输入"]');
await sleep(600);
{
  const composer = await ev(`JSON.stringify((() => {
    const ta = document.querySelector('.companion-hud__composer textarea');
    const header = document.querySelector('.companion-hud__composer > header');
    if (!ta || !header) return { err: 'composer missing' };
    const title = header.querySelector('strong');
    const close = header.querySelector('button');
    return {
      titleTruncated: title.scrollWidth > title.clientWidth + 1,
      title: title.textContent,
      closeGapToRight: Math.round(header.getBoundingClientRect().right - close.getBoundingClientRect().right),
      resize: getComputedStyle(ta).resize,
      modality: document.documentElement.dataset.inputModality,
      focusVisible: ta.matches(':focus-visible'),
      outline: getComputedStyle(ta).outlineStyle,
      formFocused: getComputedStyle(ta.closest('form')).borderColor,
    };
  })())`);
  const c = JSON.parse(composer ?? "{}");
  report(c.titleTruncated === false, "输入气泡标题不再被截断", `${c.title}`);
  report(c.closeGapToRight <= 2, "关闭按钮贴在本行右缘", `距右缘 ${c.closeGapToRight}px`);
  report(c.resize === "none", "输入框没有原生拖拽手柄", c.resize);
  report(!(c.focusVisible && c.outline !== "none" && c.modality === "pointer"), "指针点入时没有硬焦点环", `modality=${c.modality} outline=${c.outline}`);

  // 自动增高：塞三行看高度是否跟着长。
  const before = await ev(`(() => { const ta = document.querySelector('.companion-hud__composer textarea'); return Math.round(ta.getBoundingClientRect().height); })()`);
  await ev(`(() => { const ta = document.querySelector('.companion-hud__composer textarea');
    ta.focus(); document.execCommand('insertText', false, '第一行\\n第二行\\n第三行'); return 1; })()`);
  await sleep(500);
  const after = await ev(`(() => { const ta = document.querySelector('.companion-hud__composer textarea'); return Math.round(ta.getBoundingClientRect().height); })()`);
  report(Number(after) > Number(before), "输入框随内容自动长高", `${before}px → ${after}px`);
  await ev(`(() => { const ta = document.querySelector('.companion-hud__composer textarea'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(300);
}
await clickSel('.companion-hud__controls button[aria-label="文字输入"]');
await sleep(300);

// 语音失败路径必须给出可见反馈（这台机器没有可用麦克风，正好走失败分支）。
await clickSel('.companion-hud__controls button[aria-label="语音输入"]');
await sleep(1500);
{
  const voice = await ev(`JSON.stringify((() => {
    const o = document.querySelector('.companion-hud__output');
    return { visible: Boolean(o), text: o ? o.innerText.trim().slice(0, 40) : null, tone: o?.dataset.tone ?? null };
  })())`);
  const v = JSON.parse(voice ?? "{}");
  report(v.visible === true, "点语音后给出可见反馈", v.text ?? "无");
  report(v.tone === "note", "反馈是系统提示而不是她的台词", `tone=${v.tone}`);
}

await clickSel('.companion-hud__controls button[aria-label="更多功能"]');
await sleep(500);
await ev(`(() => { const b = [...document.querySelectorAll('.companion-hud__menu-index button')].find((x) => x.textContent.includes('快捷设置')); b?.click(); return 1; })()`);
await sleep(600);
{
  const settings = await ev(`JSON.stringify((() => {
    const p = document.querySelector('.companion-hud__panel');
    if (!p) return { err: 'no panel' };
    const slider = p.querySelector('input[type="range"]');
    return {
      nativeCheckbox: p.querySelectorAll('input[type="checkbox"]').length,
      nativeSelect: p.querySelectorAll('select').length,
      sliderAppearance: slider ? getComputedStyle(slider).appearance : null,
      switchCount: p.querySelectorAll('.companion-hud__switch').length,
      closeCompanion: /关闭伴星/.test(p.innerText),
      groups: p.querySelectorAll('.companion-hud__setting-group').length,
    };
  })())`);
  const s = JSON.parse(settings ?? "{}");
  report(s.nativeCheckbox === 0 && s.nativeSelect === 0, "设置面板里没有原生复选框/下拉", `checkbox=${s.nativeCheckbox}`);
  report(s.sliderAppearance === "none" && s.switchCount >= 1, "滑块与开关都是自绘控件", `slider=${s.sliderAppearance} switch=${s.switchCount}`);
  report(s.closeCompanion === false, "面板里没有「关闭伴星」", `关闭伴星=${s.closeCompanion}`);
  report(s.groups === 2, "设置面板按两个分组排布", `groups=${s.groups}`);
}
await clickSel('.companion-hud__panel header button[aria-label="关闭更多功能"]');
await sleep(250);

// ── 4. 消息气泡 × 左侧目录栏（2026-09-19） ───────────────────────────────
// 左座位的气泡比角色盒宽出一截（350 vs 245），左缘会落进目录栏里 —— 实测展开态压住 31px。
// 让位要在两个状态下都成立：展开时让开，收起成左下角小岛后收回原位。判据取真实 rect，
// 不看 "让位计算有没有跑" 的自述。
console.log("\n[4] 气泡与左侧目录栏的让位");
const CHANNEL = [
  "(() => {",
  "  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();",
  "    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };",
  "  const hit = (a, b) => (a && b) ? !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t) : false;",
  "  const inside = (a) => !a || (a.l >= 0 && a.r <= innerWidth && a.t >= 0 && a.b <= innerHeight);",
  "  const rail = box(document.querySelector('.hud-rail'));",
  "  const bubble = box(document.querySelector('.companion-hud__output'));",
  "  const steps = box(document.querySelector('.companion-hud__rail'));",
  "  return JSON.stringify({ page: document.querySelector('.desktop-app')?.dataset.hudPage,",
  "    collapsed: document.querySelector('.desktop-app')?.classList.contains('nav-collapsed'),",
  "    compLeft: document.querySelector('.desktop-app')?.classList.contains('comp-left'),",
  "    rail, bubble, steps, bubbleHit: hit(bubble, rail), stepsHit: hit(steps, rail),",
  "    inside: inside(bubble) && inside(steps),",
  "    clearance: document.querySelector('.companion-hud')?.dataset.bubbleClearance ?? null });",
  "})()",
].join("\n");
{
  await ev(`(() => { const b = [...document.querySelectorAll('.hud-rail button')].find((x) => (x.getAttribute('aria-label') || '').includes('复习')); b?.click(); return 1; })()`);
  await sleep(1600);
  // 这台机器没有可用麦克风：点语音正好走失败分支，头顶气泡会挂 5s，够量两次。
  const voice = '.companion-hud__controls button[aria-label="语音输入"]';
  const snap = async () => {
    for (let i = 0; i < 3; i += 1) {
      try { return JSON.parse(await ev(CHANNEL)); } catch { await sleep(500); }
    }
    return null;
  };
  // 前置状态对齐：[2] 的「收起目录」会把目录栏留在收起态（本地偏好，跨段生效）；
  // 语音按钮是开关，气泡已经开着时再点一下反而会关掉。所以先把目录栏展开、
  // 气泡"没开才点"，再开始量。
  let pre = await snap();
  if (!pre) { report(false, "页面状态可读", "TIMEOUT"); }
  if (pre?.collapsed) { await clickSel(".nav-collapse"); await sleep(900); pre = await snap(); }
  if (pre && !pre.bubble) { await clickSel(voice); await sleep(1300); }
  const expanded = (await snap()) ?? pre;
  report(expanded.compLeft === true, "复习队列是左座位（这条闸门的前提）", `compLeft=${expanded.compLeft}`);
  report(Boolean(expanded.bubble), "气泡已出现（否则下面两条是空断言）", expanded.bubble ? "可量" : "无气泡");
  report(!expanded.bubbleHit && !expanded.stepsHit, "目录栏展开时气泡与步骤轨道都不压目录栏",
    `气泡=${JSON.stringify(expanded.bubble)} 目录栏=${JSON.stringify(expanded.rail)} 让位=${expanded.clearance}`);
  report(expanded.inside, "让位没有把气泡顶出窗口", `气泡=${JSON.stringify(expanded.bubble)}`);

  await clickSel(".nav-collapse");
  await sleep(900);
  if (!(await snap())?.bubble) { await clickSel(voice); await sleep(1300); }
  const collapsed = await snap();
  report(collapsed.collapsed === true, "目录栏已收起（左下角小岛）", `collapsed=${collapsed.collapsed}`);
  report(!collapsed.bubbleHit && !collapsed.stepsHit, "收起后同样不压（小岛与气泡垂直不相交）",
    `气泡=${JSON.stringify(collapsed.bubble)} 目录栏=${JSON.stringify(collapsed.rail)} 让位=${collapsed.clearance}`);
  report(collapsed.inside, "收起态气泡仍在窗口内", `气泡=${JSON.stringify(collapsed.bubble)}`);
  await shot("bubble-vs-rail-collapsed");

  // 收尾：把目录栏恢复成展开（这是用户的本地偏好，审计不留下副作用）。
  await clickSel(".nav-collapse");
  await sleep(700);
  if (!(await snap())?.bubble) { await clickSel(voice); await sleep(1300); }
  const restored = await snap();
  report(restored.collapsed === false && !restored.bubbleHit, "恢复展开后仍然不压",
    `让位=${restored.clearance}`);
  await shot("bubble-vs-rail-expanded");
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
