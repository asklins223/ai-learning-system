import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationSubtitle,
  formatMessageTime,
  formatRelativeTime,
  mergeMessages,
  seqFromEventId,
  textFromBlocks,
  type Conversation,
  type Message,
} from "./conversation-model";

function message(id: string, role: string, blocks: unknown, seq = 0, createdAt = "2026-08-12T00:00:00.000Z"): Message {
  return { id, role, seq, blocks, createdAt };
}

test("textFromBlocks concatenates text blocks with newlines", () => {
  assert.equal(
    textFromBlocks([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]),
    "第一段\n第二段",
  );
  assert.equal(textFromBlocks([{ type: "image" }, { type: "text", text: "仅一段" }]), "仅一段");
  assert.equal(textFromBlocks(null), "");
  assert.equal(textFromBlocks([{ type: "text" }]), "");
  assert.equal(textFromBlocks([{ text: 42 }]), "");
});

test("mergeMessages prefers incoming and keeps pending placeholders", () => {
  const incoming = [
    message("m1", "user", [], 1),
    message("m2", "assistant", [], 2),
  ];
  const current = [
    message("m1", "user", [], 1),
    message("pending-abc", "user", [], 0),
    message("assistant-run1", "assistant", [], 0),
  ];
  const merged = mergeMessages(current, incoming);
  assert.deepEqual(merged.map((item) => item.id), ["m1", "m2", "pending-abc"]);
});

test("mergeMessages keeps assistant run placeholder only when requested", () => {
  const current = [
    message("pending-abc", "user", [], 0),
    message("assistant-run9", "assistant", [], 0),
  ];
  assert.deepEqual(
    mergeMessages(current, [], "run9").map((item) => item.id),
    ["pending-abc", "assistant-run9"],
  );
  assert.deepEqual(mergeMessages(current, []).map((item) => item.id), ["pending-abc"]);
});

test("mergeMessages returns incoming directly when current is empty", () => {
  const incoming = [message("m1", "user", [])];
  assert.equal(mergeMessages([], incoming), incoming);
});

test("seqFromEventId parses trailing seq and falls back to 0", () => {
  assert.equal(seqFromEventId("conv_123:7"), 7);
  assert.equal(seqFromEventId("conv_123:42"), 42);
  assert.equal(seqFromEventId("conv_123"), 0);
  assert.equal(seqFromEventId(""), 0);
});

test("formatRelativeTime covers 刚刚/分钟/小时/天/日期 buckets", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(new Date(now - 5_000).toISOString()), "刚刚");
  assert.equal(formatRelativeTime(new Date(now - 3 * 60_000).toISOString()), "3 分钟前");
  assert.equal(formatRelativeTime(new Date(now - 2 * 3_600_000).toISOString()), "2 小时前");
  // 1 天前 → relativeTime 返回 "昨天"
  assert.equal(formatRelativeTime(new Date(now - 1 * 86_400_000).toISOString()), "昨天");
  assert.equal(formatRelativeTime(new Date(now - 3 * 86_400_000).toISOString()), "3 天前");
  // ≥7 天走 toLocaleDateString("zh-CN", { month: "short", day: "numeric" }) → "M月D日"
  assert.match(formatRelativeTime(new Date(now - 30 * 86_400_000).toISOString()), /^\d{1,2}月\d{1,2}日$/);
  assert.equal(formatRelativeTime(null), "");
  assert.equal(formatRelativeTime("not-a-date"), "");
});

test("conversationSubtitle prefers lastMessageAt over createdAt", () => {
  const base: Conversation = { id: "c1", title: "会话", createdAt: new Date(Date.now() - 86_400_000).toISOString(), lastMessageAt: null };
  // 1 天前 → relativeTime 返回 "昨天"
  assert.equal(conversationSubtitle(base), "昨天");
  assert.equal(
    conversationSubtitle({ ...base, lastMessageAt: new Date(Date.now() - 60_000).toISOString() }),
    "1 分钟前",
  );
});

test("formatMessageTime shows HH:MM today, 昨天 and M月D日 buckets", () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30);
  assert.equal(formatMessageTime(today.toISOString()), "09:30");
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 21, 5);
  assert.equal(formatMessageTime(yesterday.toISOString()), "昨天 21:05");
  const old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10, 8, 0);
  assert.equal(formatMessageTime(old.toISOString()), `${old.getMonth() + 1}月${old.getDate()}日 08:00`);
  assert.equal(formatMessageTime("not-a-date"), "");
});
