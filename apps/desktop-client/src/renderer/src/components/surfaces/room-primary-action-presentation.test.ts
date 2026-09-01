import { describe, expect, it } from "vitest";
import { studyActionDescription } from "./room-primary-action-presentation";

describe("Study primary action public copy", () => {
  it("describes resume progress without exposing the server run identity", () => {
    const action = {
      kind: "resume_run" as const,
      runId: "7a0bd3c4-1111-4111-8111-111111111111",
      objectiveId: "00000000-0000-4000-8000-000000000001",
    };

    const description = studyActionDescription(action);

    expect(description).toBe("恢复服务端已保存的学习进度。");
    expect(description).not.toContain("7a0bd3c4");
  });
});
