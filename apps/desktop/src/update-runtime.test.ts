import assert from "node:assert/strict";
import { test } from "node:test";
import { createUpdateRuntime, type UpdateDriverV1 } from "./update-runtime.ts";

function driverFixture() {
  const listeners = new Map<string, (...args: never[]) => void>();
  let feedUrl: string | null = null;
  let checkCalls = 0;
  let downloadCalls = 0;
  let installCalls = 0;
  const driver: UpdateDriverV1 = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    setFeedURL(value) {
      feedUrl = value;
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    async checkForUpdates() {
      checkCalls += 1;
    },
    async downloadUpdate() {
      downloadCalls += 1;
    },
    quitAndInstall() {
      installCalls += 1;
    },
  };
  return {
    driver,
    get feedUrl() { return feedUrl; },
    get checkCalls() { return checkCalls; },
    get downloadCalls() { return downloadCalls; },
    get installCalls() { return installCalls; },
    emit(event: string, ...args: unknown[]) {
      const listener = listeners.get(event);
      if (listener) (listener as (...values: unknown[]) => void)(...args);
    },
  };
}

test("updater runtime：显式 HTTPS feed 才启用，且关闭自动安装", async () => {
  const fixture = driverFixture();
  const runtime = createUpdateRuntime({
    feedUrl: "https://updates.example.test/ai-learn",
    runningVersion: "0.5.0",
    driver: fixture.driver,
  });
  assert.equal(runtime.enabled, true);
  assert.equal(fixture.feedUrl, "https://updates.example.test/ai-learn");
  assert.equal(fixture.driver.autoDownload, false);
  assert.equal(fixture.driver.autoInstallOnAppQuit, false);
  assert.equal(fixture.driver.allowDowngrade, false);

  await runtime.check();
  assert.equal(fixture.checkCalls, 1);
  fixture.emit("update-available", { version: "0.6.0" });
  // 2026-08-12（更新闭环修复）：update-available 后自动触发下载，无需手动 download()
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.downloadCalls, 1);
  fixture.emit("update-downloaded", { version: "0.6.0" });
  assert.equal(runtime.state().phase, "ready");
  runtime.install();
  assert.equal(fixture.installCalls, 1);
});

test("updater 自动下载：update-available 即下载，下载失败进 error 且保留版本", async () => {
  const fixture = driverFixture();
  const states: string[] = [];
  const runtime = createUpdateRuntime({
    feedUrl: "https://updates.example.test/ai-learn",
    runningVersion: "0.5.0",
    driver: fixture.driver,
    onStateChange: (state) => states.push(state.phase),
  });
  await runtime.check();
  fixture.emit("update-available", { version: "0.6.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.downloadCalls, 1);
  assert.equal(runtime.state().phase, "downloading");
  fixture.emit("update-downloaded", { version: "0.6.0" });
  assert.equal(runtime.state().phase, "ready");
  // 状态回调随每次推进触发（checking → downloading → ready）
  assert.ok(states.includes("ready"));

  // 下载失败：error 态保留运行版本，安装不被放行
  const failing = driverFixture();
  const failingRuntime = createUpdateRuntime({
    feedUrl: "https://updates.example.test/ai-learn",
    runningVersion: "0.5.0",
    driver: failing.driver,
  });
  await failingRuntime.check();
  failing.emit("update-available", { version: "0.6.0" });
  failing.emit("error", { code: "NETWORK_TIMEOUT" });
  const state = failingRuntime.state();
  assert.equal(state.phase, "error");
  assert.equal(state.runningVersion, "0.5.0");
  assert.equal(state.errorCode, "NETWORK_TIMEOUT");
});

test("updater rollback：下载/安装失败不改变当前运行版本", async () => {
  const fixture = driverFixture();
  const runtime = createUpdateRuntime({
    feedUrl: "https://updates.example.test/ai-learn",
    runningVersion: "0.5.0",
    driver: fixture.driver,
  });
  await runtime.check();
  fixture.emit("update-available", { version: "0.6.0" });
  fixture.emit("error", { code: "SIGNATURE_INVALID" });
  const state = runtime.state();
  assert.equal(state.phase, "error");
  assert.equal(state.version, "0.6.0");
  assert.equal(state.runningVersion, "0.5.0");
  assert.equal(state.errorCode, "SIGNATURE_INVALID");
  assert.equal(fixture.installCalls, 0);
});

test("updater fail closed：未配置/非 HTTPS feed 不触发检查", async () => {
  const empty = driverFixture();
  const emptyRuntime = createUpdateRuntime({
    feedUrl: null,
    runningVersion: "0.5.0",
    driver: empty.driver,
  });
  assert.equal(emptyRuntime.enabled, false);
  assert.equal(emptyRuntime.state().errorCode, "UPDATE_FEED_NOT_CONFIGURED");
  await emptyRuntime.check();
  assert.equal(empty.checkCalls, 0);

  const invalid = driverFixture();
  const invalidRuntime = createUpdateRuntime({
    feedUrl: "http://updates.example.test/ai-learn",
    runningVersion: "0.5.0",
    driver: invalid.driver,
  });
  assert.equal(invalidRuntime.enabled, false);
  assert.equal(invalidRuntime.state().errorCode, "UPDATE_FEED_INVALID");
  assert.equal(invalid.feedUrl, null);
});
