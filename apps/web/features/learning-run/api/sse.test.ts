/**
 * learning-run api/sse 解析单元测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseChunk } from "./sse";

test("parseSseChunk：解析 id/event/data 三字段", () => {
  const events = parseSseChunk(
    'id: 3\nevent: learning_task.presented\ndata: {"taskId":"t1"}\n\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 3);
  assert.equal(events[0].eventType, "learning_task.presented");
  assert.deepEqual(events[0].payload, { taskId: "t1" });
});

test("parseSseChunk：多事件块与多行 data 拼接", () => {
  const events = parseSseChunk(
    'id: 1\nevent: learning_run.created\ndata: {}\n\n' +
    'id: 2\nevent: learning_run.started\ndata: {"a":1}\n\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[1].sequence, 2);
});

test("parseSseChunk：缺 id 或 event 的块被跳过", () => {
  const events = parseSseChunk(
    'id: 5\nevent: learning_run.paused\ndata: {}\n\n' +
    'event: no_id\ndata: {}\n\n' +
    'id: 7\ndata: {}\n\n',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 5);
});

test("parseSseChunk：非法 JSON data 不抛错（payload 空对象）", () => {
  const events = parseSseChunk('id: 9\nevent: learning_run.completed\ndata: not-json\n\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {});
});

test("parseSseChunk：不完整块（无空行结尾）也解析", () => {
  const events = parseSseChunk('id: 11\nevent: learning_run.ended\ndata: {}');
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 11);
});

test("parseSseChunk：空输入返回空数组", () => {
  assert.deepEqual(parseSseChunk(""), []);
});
