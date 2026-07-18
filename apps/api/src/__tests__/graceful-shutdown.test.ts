import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGracefulShutdown } from "../lib/graceful-shutdown.ts";

describe("graceful shutdown", () => {
  it("clears maintenance and closes server/database once in order", async () => {
    const calls: string[] = [];
    const controller = createGracefulShutdown({
      clearTimer: () => calls.push("clear-timer"),
      closeServer: async () => {
        calls.push("close-server");
      },
      closeDatabase: async () => {
        calls.push("close-database");
      },
    });

    assert.equal(controller.isShuttingDown(), false);
    const first = controller.shutdown("SIGTERM");
    const repeated = controller.shutdown("SIGINT");
    assert.equal(controller.isShuttingDown(), true);
    assert.equal(first, repeated);
    await first;
    assert.deepEqual(calls, ["clear-timer", "close-server", "close-database"]);
  });

  it("still closes the database when server shutdown fails", async () => {
    let databaseClosed = false;
    const controller = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {
        throw new Error("server close failed");
      },
      closeDatabase: async () => {
        databaseClosed = true;
      },
    });

    await assert.rejects(controller.shutdown("SIGTERM"), /server close failed/);
    assert.equal(databaseClosed, true);
  });
});
