import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkspaceTransactionContextCompatible,
  normalizeWorkspaceTransactionContext,
  WorkspaceTransactionContextError,
} from "../db/client.ts";

const WORKSPACE_ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const USER_ID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

test("workspace transaction context validates and canonicalizes UUIDs without a database", () => {
  assert.deepEqual(
    normalizeWorkspaceTransactionContext({ workspaceId: ` ${WORKSPACE_ID} `, userId: USER_ID }),
    {
      workspaceId: WORKSPACE_ID.toLowerCase(),
      userId: USER_ID.toLowerCase(),
    },
  );
  assert.throws(
    () => normalizeWorkspaceTransactionContext({ workspaceId: "not-a-uuid", userId: USER_ID }),
    WorkspaceTransactionContextError,
  );
  assert.throws(
    () => normalizeWorkspaceTransactionContext({ workspaceId: WORKSPACE_ID, userId: "" }),
    WorkspaceTransactionContextError,
  );
  assert.throws(
    () => normalizeWorkspaceTransactionContext({ workspaceId: WORKSPACE_ID, userId: null as never }),
    WorkspaceTransactionContextError,
  );
});

test("nested workspace transaction context fails closed on tenant or actor changes", () => {
  const active = normalizeWorkspaceTransactionContext({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  assert.doesNotThrow(() => assertWorkspaceTransactionContextCompatible(active, { ...active }));
  assert.throws(
    () => assertWorkspaceTransactionContextCompatible(active, {
      workspaceId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      userId: active.userId,
    }),
    /cannot change workspace or user context/,
  );
  assert.throws(
    () => assertWorkspaceTransactionContextCompatible(active, {
      workspaceId: active.workspaceId,
      userId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    }),
    /cannot change workspace or user context/,
  );
});
