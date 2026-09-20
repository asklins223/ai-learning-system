// 伴星 Agent 流程 UI 观感复核（2026-09-19）。
//
// 复核实机渲染，不读源码下结论。四块表面：
//   A. 场景层：静息接触阴影（§5 第 3 项）、被叫醒的中介帧（§5 第 4 项）
//   B. 一轮真实 agent 对话：步骤轨道（§1）、气泡单节点槽位（§3）
//   C. 中途停止：按钮同位、气泡定格、轨道收束（§6 / §5 第 8 项）
//   D. 历史抽屉：常驻输入行、过程留痕、部分回复卡（§2 / §1 历史侧）
//   E. 紧凑视口 720x405（桌面壳文档尺寸下限，按 skill 分档只报不拦）
//
// 用法：node scripts/tmp-companion-agent-ui-review.mjs [--no-turn]
// 退出码非 0 = 有 FAIL。
import { WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "outputs/companion-agent-ui-review";
const SKIP_TURN = process.argv.includes("--no-turn");
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
const ev = async (expr, timeout = 10000) => {
  const reply = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeout).then(() => null),
  ]);
  if (!reply) return "TIMEOUT";
  if (reply.result?.exceptionDetails) {
    return "EXC " + JSON.stringify(reply.result.exceptionDetails).slice(0, 200);
  }
  return reply.result?.result?.value;
};
const shot = async (name) => {
  const reply = await send("Page.captureScreenshot", { format: "png" });
  if (reply?.result?.data) await writeFile(`${OUT}/${name}.png`, Buffer.from(reply.result.data, "base64"));
};

// 冷启动复核：上一次运行留下的会话浮层（气泡 / 轨道 / 抽屉）与 mode 都会残留，
// 在残留态下量「静息影子是否在呼吸」这类结论不成立——实测上一次 C 段结束后的
// liveReply 未清，A 段就会读到 alive=false。
await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const ready = await ev(`document.querySelector('.window-live2d')?.dataset.companionStatus ?? null`);
  if (ready === "ready") break;
}
await sleep(800);
console.log("[0] 已把页面重载到初始态");

await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Page.bringToFront");
await sleep(300);

let failures = 0;
const report = (ok, label, extra) => {
  if (!ok) failures += 1;
  console.log(` ${ok ? " ok " : "FAIL"} ${label}${extra ? `  ${extra}` : ""}`);
};
const warn = (label, extra) => console.log(` warn ${label}${extra ? `  ${extra}` : ""}`);
const modeOf = () => ev(`document.querySelector('.companion-hud')?.dataset.mode ?? null`);

// ── 0. 环境 ────────────────────────────────────────────────────────────────
const base = JSON.parse(await ev(`(() => JSON.stringify({
  vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
  page: document.querySelector('.desktop-app')?.dataset.hudPage ?? null,
  policy: document.querySelector('.companion-presence')?.dataset.policyMode ?? null,
  live2d: document.querySelector('.window-live2d')?.dataset.companionStatus ?? null,
  renderer: document.querySelector('.window-live2d')?.dataset.companionRenderer ?? null,
  shadow: !!document.querySelector('.companion-contact-shadow'),
  hudMode: document.querySelector('.companion-hud')?.dataset.mode ?? null,
  // 失焦判据住在主进程（要「可见且聚焦」才算 visible），自动化沙箱拿不到 OS 级焦点，
  // 这里通常会是 hidden。记下来，免得把「窗口未被激活」读成观感问题。
  windowState: document.querySelector('.companion-presence')?.dataset.windowState ?? null,
  paused: document.querySelector('.companion-presence')?.dataset.presencePaused ?? null,
}))()`));
console.log("[0] 环境", JSON.stringify(base));
if (base.windowState !== "visible") warn("窗口未获焦点（自动化环境固有）", `windowState=${base.windowState} paused=${base.paused}`);
if (base.renderer !== "live2d") warn("Live2D 未就绪：场景层结论不成立", String(base.live2d));
await shot("00-baseline");

// ── 通用几何探针 ──────────────────────────────────────────────────────────
const GEOM = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const problems = [];
  const check = (name, r) => { if (!r) return;
    if (r.l < 0) problems.push(name + ':左溢出' + (-r.l));
    if (r.r > innerWidth) problems.push(name + ':右溢出' + (r.r - innerWidth));
    if (r.t < 0) problems.push(name + ':上溢出' + (-r.t));
    if (r.b > innerHeight) problems.push(name + ':下溢出' + (r.b - innerHeight)); };
  const rail = q('.companion-hud__rail');
  const bubble = q('.companion-hud__output');
  const shadow = q('.companion-contact-shadow');
  const shell = q('.companion-visual-shell');
  check('rail', rect(rail)); check('bubble', rect(bubble)); check('shadow', rect(shadow));
  const hit = (a, b) => a && b && !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
  const vb = shell ? shell.getBoundingClientRect() : null;
  if (vb && hit(rail?.getBoundingClientRect(), vb)) problems.push('rail:压住角色');
  if (vb && hit(bubble?.getBoundingClientRect(), vb)) problems.push('bubble:压住角色');
  // 轨道与气泡是最容易互相遮挡的一对：气泡逐行长高、轨道按 --companion-bubble-h 往上让位，
  // 两者相交就是用户说的"你遮挡我、我遮挡你"（2026-09-20 反馈）。这条以前没人断言过。
  if (hit(rail?.getBoundingClientRect(), bubble?.getBoundingClientRect())) problems.push('rail:压住气泡');
  const steps = [...document.querySelectorAll('.companion-hud__rail-steps > li')];
  // 「…+N」那行是折叠提示，不是节点：它没有 data-state，混进来会假报「未知状态」。
  const overflowRow = steps.filter((n) => n.classList.contains('companion-hud__rail-overflow'));
  const nodes = steps.filter((n) => !n.classList.contains('companion-hud__rail-overflow'));
  let gap = null; let cx = null;
  if (shadow && shell) { const s = shell.getBoundingClientRect(), b = shadow.getBoundingClientRect();
    gap = +(((s.bottom - b.bottom) / s.height) * 100).toFixed(2);
    cx = +(((b.left + b.right) / 2) - ((s.left + s.right) / 2)).toFixed(1); }
  const stop = q('.companion-hud__composer button[aria-label="停止这一轮"]');
  const sendBtn = q('.companion-hud__composer button[aria-label="发送"]');
  const bubbleStop = q('.companion-hud__output-stop');
  const sr = stop ? stop.getBoundingClientRect() : null; const nr = sendBtn ? sendBtn.getBoundingClientRect() : null;
  return JSON.stringify({ problems,
    rail: !!rail, railCollapsed: !!rail?.dataset.collapsed,
    // 场景有没有跟着视口回流：角色盒整块落在视口右侧时，"浮层上溢出"是场景座位的症状，
    // 不是浮层自己的问题（720x405 实测 anchorL=867 > vw=720）。
    anchor: rect(q('.companion-scene-anchor')),
    nodes: nodes.length,
    states: nodes.map((n) => n.dataset.state ?? '?'),
    labels: nodes.map((n) => (n.textContent || '').trim().slice(0, 14)),
    overflowRow: overflowRow.length > 0,
    progress: q('.companion-hud__rail-summary')?.textContent?.trim() ?? null,
    slot: bubble?.dataset.slot ?? null, breath: bubble?.dataset.breath ?? null,
    tone: bubble?.dataset.tone ?? null, text: (bubble?.textContent || '').trim().slice(0, 44),
    stopInComposer: !!stop, stopLabel: stop?.getAttribute('aria-label') ?? null,
    stopInBubble: !!bubbleStop, bubbleStopLabel: bubbleStop?.getAttribute('aria-label') ?? null,
    sameSlot: sr && nr ? Math.abs(sr.left - nr.left) <= 1 && Math.abs(sr.top - nr.top) <= 1 : null,
    gap, cx });
})()`;

// ── A. 静息接触阴影（§5 第 3 项） ─────────────────────────────────────────
console.log("\n[A] 静息接触阴影");

const shadowProbe = `(() => {
  const el = document.querySelector('.companion-contact-shadow');
  const shell = document.querySelector('.companion-visual-shell');
  if (!el) return JSON.stringify({ present: false });
  const b = el.getBoundingClientRect();
  const s = shell ? shell.getBoundingClientRect() : null;
  const cs = getComputedStyle(el);
  return JSON.stringify({ present: true, alive: el.hasAttribute('data-alive'),
    w: +b.width.toFixed(1), h: +b.height.toFixed(1),
    shellW: s ? +s.width.toFixed(1) : null, shellH: s ? +s.height.toFixed(1) : null,
    bottomGapPct: s ? +(((s.bottom - b.bottom) / s.height) * 100).toFixed(2) : null,
    centerOffsetPx: s ? +(((b.left + b.right) / 2) - ((s.left + s.right) / 2)).toFixed(1) : null,
    widthPctOfShell: s ? +((b.width / s.width) * 100).toFixed(1) : null,
    radial: cs.backgroundImage.includes('radial-gradient'), filter: cs.filter,
    animationName: cs.animationName, animationDuration: cs.animationDuration,
    pointerEvents: cs.pointerEvents,
    insideShell: !!(el.parentElement && el.parentElement.classList.contains('companion-visual-shell')),
    shadowBeforeCharacter: !!(document.querySelector('.companion-character-motion')
      && (el.compareDocumentPosition(document.querySelector('.companion-character-motion')) & 4)),
  });
})()`;

const shadow = JSON.parse(await ev(shadowProbe));
const motionMode = await ev(`document.querySelector('.companion-hud')?.dataset.motion ?? null`);
if (!shadow.present) {
  warn("影子未渲染（bust 取景 / Live2D 未就绪 / 已隐藏时属预期）", `page=${base.page}`);
} else {
  console.log("   ", JSON.stringify(shadow), `motionMode=${motionMode}`);
  report(shadow.insideShell, "挂在角色外壳里（room 座位下外壳比锚点窄，挂锚点会偏）");
  report(shadow.shadowBeforeCharacter, "画序：在角色之前（被她盖住，不浮在她脸上）");
  report(Math.abs(shadow.bottomGapPct - 2) <= 1.2, "脚尖落点：底边在容器底边之上约 2%",
    `${shadow.bottomGapPct}%（驱动 full 取景把内容盒下沿放在 height*0.98）`);
  report(Math.abs(shadow.centerOffsetPx) <= 2, "水平对中", `偏移 ${shadow.centerOffsetPx}px`);
  report(shadow.pointerEvents === "none", "不挡指针", shadow.pointerEvents);
  report(shadow.radial, "形状：径向渐变椭圆", shadow.filter);
  // data-alive 只在 full 档 + 她不在发送/说话时挂。环境不是 full 时不能算缺陷。
  if (motionMode === "full") {
    report(shadow.alive && shadow.animationName === "companion-contact-breathe" && shadow.animationDuration === "5s",
      "静息呼吸：data-alive 下 5s 周期", `${shadow.animationName}/${shadow.animationDuration}`);
  } else {
    warn("环境动效档不是 full，跳过静息呼吸断言", `motionMode=${motionMode}`);
  }
  console.log(`   → 影子 ${shadow.w}x${shadow.h}px，占容器宽 ${shadow.widthPctOfShell}%（容器 ${shadow.shellW}x${shadow.shellH}）`);
}
await shot("01-shadow");

await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await sleep(600);
const reduced = JSON.parse(await ev(shadowProbe));
report(!reduced.present || reduced.animationName === "none",
  "减少动效：影子停住但仍在（信息不丢）", `animationName=${reduced.animationName}`);
await shot("02-shadow-reduced-motion");
await send("Emulation.setEmulatedMedia", { features: [] });
await sleep(600);

// ── B. 被叫醒的中介帧（§5 第 4 项） ───────────────────────────────────────
console.log("\n[B] 被叫醒的中介帧「嗯？」");

const WELCOME = `(() => {
  const el = document.querySelector('.companion-wake-bubble');
  const shell = document.querySelector('.companion-visual-shell');
  if (!el) return JSON.stringify({ present: false });
  const b = el.getBoundingClientRect();
  const s = shell ? shell.getBoundingClientRect() : null;
  const cs = getComputedStyle(el);
  return JSON.stringify({ present: true, text: el.textContent.trim(),
    aboveShellTop: s ? b.bottom <= s.top + 2 : null,
    cxOffset: s ? +(((b.left + b.right) / 2) - ((s.left + s.right) / 2)).toFixed(1) : null,
    animationName: cs.animationName, animationDuration: cs.animationDuration,
    fontSize: cs.fontSize, color: cs.color, background: cs.backgroundColor });
})()`;
const clickHero = `(() => { const b = document.querySelector('.companion-visual-shell button'); if (!b) return 'MISSING'; b.click(); return 'ok'; })()`;

let mode = await modeOf();
if (mode !== "closed") { await ev(clickHero); await sleep(400); mode = await modeOf(); }
report(mode === "closed", "前置：交互台已复位到 closed", String(mode));

await ev(clickHero);
// 只读、不截图地刷时间线：截图本身几百毫秒，会把 0.9s 的寿命量歪。
const timeline = [];
for (let i = 0; i < 16; i += 1) {
  const present = (await ev(`!!document.querySelector('.companion-wake-bubble')`)) === true;
  const m = await modeOf();
  timeline.push({ t: i * 100, present, mode: m });
  if (!present && i > 2) break;
  await sleep(100);
}
console.log("   时间线", JSON.stringify(timeline.map((x) => `${x.t}ms:${x.present ? "有" : "无"}/${x.mode}`)));

const first = timeline[0];
const firstGone = timeline.find((x) => !x.present);
const openedAt = timeline.find((x) => x.mode === "conversation");
report(first.present === true, "点她即出现「嗯？」（100ms 内）");
report(openedAt !== undefined && openedAt.t >= 100, "交互台在同一时刻还没展开（顺序是「先冒气泡」）",
  `展开于 ~${openedAt?.t}ms，mode=${openedAt?.mode}`);
report(firstGone !== undefined && firstGone.t >= 800 && firstGone.t <= 1200,
  "「嗯？」活满约 0.9s 再收", `实测收于 ~${firstGone?.t}ms`);
const overlap = timeline.some((x) => x.present && x.mode === "conversation");
report(overlap, "交互台展开时「嗯？」仍在（不被打断）");

// 视觉细节单独取一次（关掉动画计时影响）
await ev(clickHero); await sleep(400);   // 收起
await ev(clickHero); await sleep(60);
const w = JSON.parse(await ev(WELCOME));
if (w.present) {
  report(w.text === "嗯？", "文案", JSON.stringify(w.text));
  report(w.aboveShellTop === true, "位置在头顶（底边不越过角色盒顶边）", `水平偏移 ${w.cxOffset}px`);
  report(w.animationName === "companion-wake-in" && w.animationDuration === "0.18s",
    "入场：180ms 弹入", `${w.animationName}/${w.animationDuration}`);
  console.log(`   → 字号 ${w.fontSize}，色 ${w.color}，底 ${w.background}`);
  await shot("03-wake-bubble");
} else {
  warn("第二次取景没抓到「嗯？」（可能已在 180ms 节拍之后）");
}
await sleep(1200);
await shot("04-hud-open");

// ── C. 一轮真实 agent 对话（§1 §3）+ 中途停止（§6 §5-8） ─────────────────
console.log("\n[C] 一轮真实 agent 对话（含中途停止）");

if (SKIP_TURN) {
  warn("--no-turn：跳过真实对话段");
} else {
  const ensureConversation = async () => {
    if ((await modeOf()) !== "conversation") {
      await ev(`(() => { const b = document.querySelector('.companion-hud__controls button[aria-label="文字输入"]'); b?.click(); return 1; })()`);
      await sleep(400);
    }
    return await modeOf();
  };
  mode = await ensureConversation();
  report(mode === "conversation", "交互台在 conversation 态", String(mode));

  const SEND_TEXT = "看一下我今天的复习进度";
  const send_ = await ev(`(() => {
    const ta = document.querySelector('.companion-hud__composer textarea');
    if (!ta) return 'NO_COMPOSER';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(SEND_TEXT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(120);
  const submitted = await ev(`(() => {
    const btn = document.querySelector('.companion-hud__composer button[aria-label="发送"]');
    if (!btn || btn.disabled) return 'NO_SEND_BUTTON';
    btn.click(); return 'ok';
  })()`);
  console.log(`   输入 ${send_} / 发送 ${submitted}：${JSON.stringify(SEND_TEXT)}`);

  if (submitted !== "ok") {
    warn("发送没成功，跳过", submitted);
  } else {
    const samples = [];
    let stopped = false;
    let shotDuringTurn = false;
    for (let i = 0; i < 40; i += 1) {
      const s = JSON.parse(await ev(GEOM));
      samples.push({ i, rail: s.rail, nodes: s.nodes, states: s.states, labels: s.labels,
        progress: s.progress, slot: s.slot, tone: s.tone, text: s.text, stop: s.stopInComposer,
        stopInBubble: s.stopInBubble, problems: s.problems });
      if (s.rail && s.nodes > 0 && !shotDuringTurn) { shotDuringTurn = true; await shot("05-agent-turn"); }
      // 看到了正在跑的轨道且已经有节点，就在半途停下，验证 §6 的客户端链路
      if (!stopped && s.rail && s.nodes > 0 && s.stopInComposer) {
        stopped = true;
        // 断言用**点之前**那一帧：点下去之后 phase 可能立刻离开 sending，按钮随之消失，
        // 拿点之后的状态去断言「按钮语义/同位」会假 FAIL。
        report(s.stopLabel === "停止这一轮", "生成中发送按钮原位变「停止」（语义正确）", String(s.stopLabel));
        report(s.sameSlot !== false, "停止按钮与发送按钮同位（不让手指追按钮）", `同槽=${s.sameSlot}`);
        report(s.stopInBubble === true, "生成中气泡右下角也有「停止」（视线不用离开气泡）");
        await ev(`(() => { const b = document.querySelector('.companion-hud__composer button[aria-label="停止这一轮"]'); if (b) b.click(); return 1; })()`);
        console.log(`   在生成中点下「停止这一轮」（当时 ${s.nodes} 个节点：${JSON.stringify(s.labels)}，摘要 ${JSON.stringify(s.progress)}）`);
        continue;
      }
      if (stopped && !s.rail) { break; }
      await sleep(1000);
    }
    const withNodes = samples.filter((s) => s.nodes > 0);
    const last = samples[samples.length - 1];
    console.log("   采样摘要：", JSON.stringify({
      samples: samples.length,
      sawRail: samples.some((s) => s.rail),
      maxNodes: Math.max(0, ...samples.map((s) => s.nodes)),
      allStates: [...new Set(samples.flatMap((s) => s.states))],
      nodeLabels: [...new Set(withNodes.flatMap((s) => s.labels))],
      slots: [...new Set(samples.map((s) => s.slot).filter(Boolean))],
      progressSeen: samples.map((s) => s.progress).filter(Boolean).slice(-3),
      problems: [...new Set(samples.flatMap((s) => s.problems))],
    }));

    if (!samples.some((s) => s.rail)) {
      warn("整轮没出现步骤轨道：按 §1，single_step（闲聊）本就不该出现轨道");
    } else {
      report(Math.max(0, ...samples.map((s) => s.nodes)) > 0, "轨道上出现过节点",
        `最多 ${Math.max(0, ...samples.map((s) => s.nodes))} 行`);
      const OK_STATES = ["running", "succeeded", "failed", "cancelled", "waiting_confirmation"];
      const bad = [...new Set(samples.flatMap((s) => s.states))].filter((x) => !OK_STATES.includes(x));
      report(bad.length === 0, "节点状态都在五档之内", bad.length ? JSON.stringify(bad) : "");
      report(Math.max(0, ...samples.map((s) => s.nodes)) <= 4,
        "轨道不无限增长（最多 3 步 + 更早折叠成 …+N，合计 4 行上限）",
        `最多 ${Math.max(0, ...samples.map((s) => s.nodes))} 行`);
      report(samples.some((s) => (s.slot ?? "") !== ""), "气泡在生成期间切到过程槽位",
        `见过的槽位 ${JSON.stringify([...new Set(samples.map((s) => s.slot).filter(Boolean))])}`);
    }
    report(last.problems.length === 0, "全程浮层不溢出窗口、不压住角色", JSON.stringify(last.problems));

    // 等收敛，看停止的余韵
    await sleep(2500);
    const after = JSON.parse(await ev(GEOM));
    console.log("   停止后稳态：", JSON.stringify({ slot: after.slot, tone: after.tone, breath: after.breath,
      text: after.text, rail: after.rail, collapsed: after.railCollapsed, states: after.states }));
    if (stopped) {
      report(after.slot === "stopped" || after.tone === "stopped" || after.railCollapsed
        || after.states.includes("cancelled"),
        "停止后气泡定格 / 轨道收束（§5-8、§6）",
        `slot=${after.slot} tone=${after.tone} collapsed=${after.railCollapsed}`);
      report((await ev(`!!document.querySelector('.companion-hud__composer button[aria-label="停止这一轮"]')`)) === false,
        "停止完成后按钮回到「发送」");
      // §6 的收尾文案是「已停止 · 思考 2 步 · 调用 1 次工具」：步数只能来自刚结束那一轮
      // 的 run 摘要，所以这里钉住它——收起后只剩「1 次工具」就是丢了"被停掉"这件事。
      report(typeof after.progress === "string" && after.progress.startsWith("已停止"),
        "收起的轨道仍写明「已停止」并带步数（§6 收尾文案）", JSON.stringify(after.progress));
      if (typeof after.progress === "string" && !/已停止/.test(after.progress)) {
        console.log(`   → 实测摘要：${JSON.stringify(after.progress)}（缺「已停止」或步数）`);
      }
    }
    await shot("06-after-stop");
  }
}

// ── D. 历史抽屉（§2 / §1 历史侧） ─────────────────────────────────────────
console.log("\n[D] 连续对话抽屉");
// 入口在「更多功能」里，而这个按钮是 toggle（`actions → closed`），点几次都不一定落在
// actions 上；循环到 mode 真的是 actions 为止，比"猜它现在在哪个态"稳。
const clickMore = `(() => { const m = document.querySelector('.companion-hud__controls button[aria-label="更多功能"]'); if (!m) return 'NO_BUTTON'; m.click(); return 'ok'; })()`;
for (let attempt = 0; attempt < 3 && (await modeOf()) !== "actions"; attempt += 1) {
  await ev(clickMore);
  await sleep(600);
}
const enteredActions = await modeOf();
// 菜单页是 `moreView` 的默认值，但它是组件 state（面板关闭不重置），所以找不到入口时
// 先点「返回更多功能」退回菜单页再找一次。
const findHistory = `(() => {
  const b = [...document.querySelectorAll('.companion-hud__panel button')].find((x) => (x.textContent || '').includes('对话记录'));
  if (!b) return 'NO_ENTRY';
  b.click(); return 'ok';
})()`;
let clickedHistory = await ev(findHistory);
if (clickedHistory === "NO_ENTRY") {
  await ev(`(() => { const b = document.querySelector('.companion-hud__panel button[aria-label="返回更多功能"]'); if (b) b.click(); return 1; })()`);
  await sleep(500);
  clickedHistory = await ev(findHistory);
}
console.log(`   更多功能=${enteredActions} / 点对话记录=${clickedHistory}`);
await sleep(1400);
const drawer = await ev(`(() => {
  const d = document.querySelector('.companion-history');
  if (!d) return JSON.stringify({ opened: false });
  const textarea = d.querySelector('.companion-history__composer textarea');
  const trace = d.querySelector('.companion-history__trace');
  const b = d.getBoundingClientRect();
  const cs = getComputedStyle(d);
  return JSON.stringify({ opened: true,
    rect: { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) },
    stage: d.dataset.stage, visibility: cs.visibility, opacity: cs.opacity,
    inViewport: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
    hasComposer: !!textarea, composerLabel: textarea?.getAttribute('aria-label') ?? null,
    composerDisabled: textarea?.disabled ?? null,
    hasTrace: !!trace, traceItems: trace ? trace.querySelectorAll('li').length : 0,
    traceTexts: trace ? [...trace.querySelectorAll('li')].map((n) => (n.textContent || '').trim().slice(0, 16)) : [],
    traceStates: trace ? [...trace.querySelectorAll('li')].map((n) => n.dataset.state ?? '?') : [],
    cancelledCards: d.querySelectorAll('article[data-cancelled]').length,
    stopSummary: [...d.querySelectorAll('*')].map((n) => (n.textContent || '').trim())
      .find((t) => t.startsWith('你在这里停下了')) ?? null,
  });
})()`);
console.log("   ", drawer);
const dr = JSON.parse(drawer);
if (!dr.opened) {
  warn("抽屉没打开");
} else {
  report(dr.inViewport, "抽屉在视口内", JSON.stringify(dr.rect));
  report(dr.hasComposer === true, "抽屉有常驻输入行", String(dr.composerLabel));
  report(dr.composerDisabled !== true, "输入行可用（不是禁用占位）");
  if (dr.traceItems > 0) {
    console.log(`   → 过程留痕 ${dr.traceItems} 条 ${JSON.stringify(dr.traceStates)}：${JSON.stringify(dr.traceTexts)}`);
  } else {
    warn("历史里没有过程留痕（该会话若只是 single_step、或事件已过 TTL，都属预期）");
  }
  if (dr.cancelledCards > 0) console.log(`   → 部分回复卡 ${dr.cancelledCards} 张；注记 ${JSON.stringify(dr.stopSummary)}`);
  else warn("历史里没有部分回复卡（没被停止过则属预期）");
}
await shot("07-drawer");

// ── E. 紧凑视口（桌面壳文档尺寸下限，按 skill 分档只报不拦） ──────────────
console.log("\n[E] 紧凑视口 720x405（= 桌面壳文档尺寸下限）");
await ev(`(() => { const b = document.querySelector('.companion-history button[aria-label="关闭对话记录"]'); b?.click(); return 1; })()`);
await sleep(400);
await send("Emulation.setDeviceMetricsOverride", { width: 720, height: 405, deviceScaleFactor: 1, mobile: false });
await sleep(1200);
// 入场动画（200ms pop）期间量到的 rect 是位移中的，会假报溢出 → 多次采样取中位。
const compactSamples = [];
for (let i = 0; i < 4; i += 1) {
  compactSamples.push(JSON.parse(await ev(GEOM)));
  await sleep(450);
}
const compactProblems = [...new Set(compactSamples.flatMap((s) => s.problems))];
const compactAnchor = compactSamples[0].anchor ?? null;
console.log("   角色盒：", JSON.stringify(compactAnchor),
  compactAnchor && compactAnchor.l >= 720
    ? "→ 场景在 405px 高时没有回流（角色整块在视口右外侧）：这里的上溢出是座位症状，不是浮层问题"
    : "");
const median = compactSamples.map((s) => s.gap).filter((x) => x !== null).sort()[1] ?? null;
const cxMedian = compactSamples.map((s) => s.cx).filter((x) => x !== null).sort()[1] ?? null;
console.log("   采样：", JSON.stringify(compactSamples.map((s) => ({ gap: s.gap, cx: s.cx, problems: s.problems }))));
if (compactProblems.length === 0) {
  report(true, "紧凑视口下浮层都在窗口内");
} else {
  const stable = compactSamples.filter((s) => s.problems.length === 0).length;
  // 视口正好落在外壳下限上（外壳自己的 inset 会把页面盒推出窗口），
  // 且瞬态多来自入场动画 → 按 skill 的分档只报不拦。
  warn(`紧凑视口下出现过溢出（${stable}/${compactSamples.length} 次采样干净）`, JSON.stringify(compactProblems));
}
if (median !== null) {
  report(Math.abs(median - 2) <= 1.5 && Math.abs(cxMedian) <= 2,
    "紧凑视口下影子仍贴脚下（取中位，避开动画瞬态）", `底边 ${median}% / 水平偏移 ${cxMedian}px`);
}
await shot("08-compact");
await send("Emulation.clearDeviceMetricsOverride");

console.log(`\n${failures === 0 ? "观感复核通过" : `观感复核有 ${failures} 项 FAIL`}（截图在 ${OUT}/）`);
process.exit(failures === 0 ? 0 : 1);
