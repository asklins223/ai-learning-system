// Live check for the DirectoryRail 星图 chip: the rail exposes the new
// destination, clicking it opens page 19, and the chip highlights as active.
import { WebSocket } from "ws";

const CDP = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.on("open", resolve); });

let seq = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  seq += 1;
  pending.set(seq, resolve);
  ws.send(JSON.stringify({ id: seq, method, params }));
});
const evaluate = async (expression) => {
  const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result?.result?.value;
};

const consoleErrors = [];
await send("Runtime.enable");
ws.on("message", (raw) => {
  const message = JSON.parse(raw);
  if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
    consoleErrors.push(message.params.args?.map((a) => a.value ?? a.description).join(" "));
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? "exception");
  }
});

const report = {};

// 1. The rail has the 星图 chip, in the understanding group.
report.railLabels = await evaluate(`Array.from(document.querySelectorAll('.hud-rail .nav-chip')).map(b => b.getAttribute('aria-label')).join('|')`);

// 2. Click it → page 19 opens, graph surface visible.
await evaluate(`document.querySelector('.hud-rail .nav-chip[aria-label="星图"]').click()`);
await sleep(1200);
report.page = await evaluate(`document.querySelector('.desktop-app')?.dataset.hudPage ?? document.querySelector('[data-hud-page]')?.dataset.hudPage ?? 'none'`);
report.surfaceOpen = await evaluate(`document.querySelector('.desktop-app')?.dataset.surfaceOpen ?? 'none'`);
report.graphVisible = await evaluate(`Boolean(document.querySelector('.universe-page'))`);
report.canvas = await evaluate(`Boolean(document.querySelector('.universe-canvas-surface'))`);
report.telemetry = await evaluate(`document.querySelector('.universe-layer-readout')?.textContent ?? null`);
report.filters = await evaluate(`document.querySelectorAll('.universe-filter').length`);
report.chipActive = await evaluate(`document.querySelector('.hud-rail .nav-chip[aria-label="星图"]')?.className ?? ''`);

// 3. Screenshot for the record.
const shot = await send("Page.captureScreenshot", { format: "png" });
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./rail-graph-entry.png", import.meta.url), Buffer.from(shot.result.data, "base64"));

report.consoleErrors = consoleErrors;
console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(0);
