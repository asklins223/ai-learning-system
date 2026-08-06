import assert from "node:assert/strict";
import { test } from "node:test";
import { countConsecutiveReadOnlySupervisorTurns } from "../handlers/card-supervisor-agent.ts";

type Event = {
  turnNo: number | null;
  toolName: string | null;
  eventType: string;
  agentRole: string | null;
};

function ev(turnNo: number, toolName: string): Event {
  return { turnNo, toolName, eventType: "tool_request", agentRole: "generation_supervisor" };
}

function otherRole(turnNo: number, toolName: string): Event {
  return { turnNo, toolName, eventType: "tool_request", agentRole: "text_extractor" };
}

test("连续只读工具 turn 计数到阈值", () => {
  // turn 1-5 全部 read_candidate_ledger（只读），turn 6 是当前 turn 又读一次
  const events = [ev(1, "read_candidate_ledger"), ev(2, "read_candidate_ledger"), ev(3, "read_candidate_ledger")];
  const count = countConsecutiveReadOnlySupervisorTurns(
    events,
    4,
    [{ name: "read_candidate_ledger" }],
  );
  assert.equal(count, 4);
});

test("出现副作用工具则中断自旋计数", () => {
  // turn 1-2 只读，turn 3 submit_deck_draft（副作用），turn 4 和当前 turn 5 又只读
  // 从 turn 5 往回：turn 5=只读, turn 4=只读, turn 3=副作用中断 → 计数 2
  const events = [
    ev(1, "read_candidate_ledger"),
    ev(2, "read_candidate_ledger"),
    ev(3, "submit_deck_draft"),
    ev(4, "read_candidate_ledger"),
  ];
  const count = countConsecutiveReadOnlySupervisorTurns(events, 5, [{ name: "read_candidate_ledger" }]);
  assert.equal(count, 2); // turn 4 + 当前 turn 5 是自旋，turn 3 中断
});

test("turnNo 为 null 的事件被安全跳过", () => {
  const events: Event[] = [
    ev(1, "read_candidate_ledger"),
    { turnNo: null, toolName: "read_candidate_ledger", eventType: "tool_request", agentRole: "generation_supervisor" },
    ev(3, "read_candidate_ledger"),
  ];
  const count = countConsecutiveReadOnlySupervisorTurns(events, 3, []);
  assert.equal(count, 1); // turn 3 只读，null 事件被跳过
});

test("非 supervisor 角色的事件不计入自旋", () => {
  const events = [otherRole(1, "read_candidate_ledger"), otherRole(2, "read_candidate_ledger")];
  const count = countConsecutiveReadOnlySupervisorTurns(events, 3, []);
  assert.equal(count, 0);
});

test("连续 2 次只读不触发（阈值 3）", () => {
  const events = [ev(1, "read_candidate_ledger"), ev(2, "read_candidate_ledger")];
  const count = countConsecutiveReadOnlySupervisorTurns(events, 3, [{ name: "read_candidate_ledger" }]);
  assert.equal(count, 3);
});
