/**
 * P6 顺序 8：tray 菜单 + 更新状态机单元测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPetTrayMenu } from "./tray-menu.ts";
import { UpdateStateMachine } from "./update-state.ts";

test("tray 菜单：pet 可见 → 隐藏项；动作映射完整", () => {
  const menu = buildPetTrayMenu({ petVisible: true });
  const toggle = menu.find((m) => m.id === "toggle-pet");
  assert.equal(toggle?.label, "隐藏宠物");
  assert.equal(toggle?.role, "togglePet");
  const roles = menu.map((m) => m.role);
  assert.deepEqual(roles, ["togglePet", "openMain", "checkUpdate", "quit"]);
});

test("tray 菜单：更新 ready 后同一入口变为“安装更新 vX”", () => {
  const menu = buildPetTrayMenu({ petVisible: true, update: { phase: "ready", version: "0.6.0" } });
  const check = menu.find((m) => m.id === "check-update");
  assert.equal(check?.label, "安装更新 0.6.0");
  assert.equal(check?.role, "checkUpdate");

  const downloading = buildPetTrayMenu({ petVisible: true, update: { phase: "downloading" } });
  assert.equal(downloading.find((m) => m.id === "check-update")?.label, "检查更新");

  const noUpdate = buildPetTrayMenu({ petVisible: true });
  assert.equal(noUpdate.find((m) => m.id === "check-update")?.label, "检查更新");
});

test("tray 菜单：pet 隐藏 → 显示项", () => {
  const menu = buildPetTrayMenu({ petVisible: false });
  assert.equal(menu.find((m) => m.id === "toggle-pet")?.label, "显示宠物");
});

test("更新状态机：空更新源 → not-supported（未冻结不自动检查）", () => {
  const m = new UpdateStateMachine("");
  const s = m.startCheck();
  assert.equal(s.phase, "not-supported");
  assert.equal(s.errorCode, "UPDATE_FEED_NOT_CONFIGURED");
});

test("更新状态机：正常检查 → 下载 → ready", () => {
  const m = new UpdateStateMachine("https://example.test/update");
  assert.equal(m.startCheck().phase, "checking");
  assert.equal(m.onEvent({ type: "update-available", version: "0.6.0" }).phase, "downloading");
  assert.equal(m.onEvent({ type: "download-progress" }).phase, "downloading");
  const s = m.onEvent({ type: "update-downloaded", version: "0.6.0" });
  assert.equal(s.phase, "ready");
  assert.equal(s.version, "0.6.0");
});

test("更新状态机：error 保持当前版本（失败回滚语义）", () => {
  const m = new UpdateStateMachine("https://example.test/update");
  m.startCheck();
  m.onEvent({ type: "update-available", version: "0.7.0" });
  const s = m.onEvent({ type: "error", code: "NETWORK_TIMEOUT" });
  assert.equal(s.phase, "error");
  assert.equal(s.errorCode, "NETWORK_TIMEOUT");
  assert.equal(s.version, "0.7.0"); // 当前版本信息保留，旧版仍可运行
});

test("更新状态机：update-not-available → idle；disabled → not-supported", () => {
  const m = new UpdateStateMachine("https://example.test/update");
  m.startCheck();
  assert.equal(m.onEvent({ type: "update-not-available" }).phase, "idle");
  assert.equal(m.onEvent({ type: "disabled" }).phase, "not-supported");
});
