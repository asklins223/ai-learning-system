import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopCapabilityProjection, type WorkspaceAiConsentFacts } from "./capability-projection.ts";
import { actionCapabilityValues } from "@ailearn/shared/desktop-ipc-contracts";

const originalRun = process.env.LEARNING_RUN_ENABLED;
const originalCard = process.env.CARD_GENERATION_V2_ENABLED;
const originalDialogue = process.env.COMPANION_DIALOGUE_V1_ENABLED;
const originalVoice = process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED;

function restoreFlags(): void {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("LEARNING_RUN_ENABLED", originalRun);
  restore("CARD_GENERATION_V2_ENABLED", originalCard);
  restore("COMPANION_DIALOGUE_V1_ENABLED", originalDialogue);
  restore("COMPANION_VOICE_DIALOGUE_V1_ENABLED", originalVoice);
}

/** 纯 mock 部署：不需要同意，因此内容外发本身是允许的。 */
const mockOnlyAi: WorkspaceAiConsentFacts = { requiresConsent: false, consentSigned: false, sendToExternal: true };

test("desktop capability projection: disabled flags fail closed and member writes stay denied", () => {
  try {
    process.env.LEARNING_RUN_ENABLED = "false";
    process.env.CARD_GENERATION_V2_ENABLED = "false";
    const projection = buildDesktopCapabilityProjection({ role: "member", ai: mockOnlyAi , workspaceEpoch: 1 });
    assert.equal(projection.actionCapabilities["learning_run.start"], "denied");
    assert.equal(projection.actionCapabilities["note.save"], "denied");
    assert.equal(projection.featureAvailability.learning_run_v2.state, "disabled");
    assert.equal(projection.featureAvailability.card_generation_v2.state, "disabled");
  } finally {
    restoreFlags();
  }
});

test("desktop capability projection: enabled flags expose only the matching owner path", () => {
  try {
    process.env.LEARNING_RUN_ENABLED = "true";
    process.env.CARD_GENERATION_V2_ENABLED = "true";
    const projection = buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi , workspaceEpoch: 1 });
    assert.equal(projection.actionCapabilities["learning_run.start"], "allowed");
    assert.equal(projection.actionCapabilities["card_generation.activate"], "allowed");
    assert.equal(projection.featureAvailability.learning_run_v2.state, "enabled");
    assert.equal(projection.featureAvailability.card_generation_v2.state, "enabled");
  } finally {
    restoreFlags();
  }
});

test("desktop capability projection: AI consent gates every companion capability", () => {
  const unsigned: WorkspaceAiConsentFacts = { requiresConsent: true, consentSigned: false, sendToExternal: true };
  const signedButHeld: WorkspaceAiConsentFacts = { requiresConsent: true, consentSigned: true, sendToExternal: false };
  const signedAndSending: WorkspaceAiConsentFacts = { requiresConsent: true, consentSigned: true, sendToExternal: true };

  for (const [label, ai, expected] of [
    ["未签署", unsigned, "denied"],
    ["已签署但策略禁止外发", signedButHeld, "denied"],
    ["已签署且允许外发", signedAndSending, "allowed"],
  ] as const) {
    const projection = buildDesktopCapabilityProjection({ role: "owner", ai , workspaceEpoch: 1 });
    for (const capability of ["companion.read", "companion.sendMessage", "companion.decideProposal"] as const) {
      assert.equal(projection.actionCapabilities[capability], expected, `${label} → ${capability}`);
    }
  }
});

test("desktop capability projection: a missing workspace row fails closed", () => {
  const projection = buildDesktopCapabilityProjection({ role: "owner", ai: null , workspaceEpoch: 1 });
  assert.equal(projection.actionCapabilities["companion.read"], "denied");
  assert.equal(projection.actionCapabilities["companion.sendMessage"], "denied");
});

test("desktop capability projection: policy management follows the owner role", () => {
  assert.equal(buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi , workspaceEpoch: 1 }).actionCapabilities["settings.update"], "allowed");
  assert.equal(buildDesktopCapabilityProjection({ role: "member", ai: mockOnlyAi , workspaceEpoch: 1 }).actionCapabilities["settings.update"], "denied");
  assert.equal(buildDesktopCapabilityProjection({ role: "member", ai: mockOnlyAi , workspaceEpoch: 1 }).actionCapabilities["settings.read"], "allowed");
});

test("desktop capability projection: companion dialogue features follow their real flags", () => {
  try {
    process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";
    process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED = "false";
    const projection = buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi , workspaceEpoch: 1 });
    assert.equal(projection.featureAvailability.companion_dialogue_v1.state, "enabled");
    assert.equal(projection.featureAvailability.companion_voice_dialogue_v1.state, "disabled");
  } finally {
    restoreFlags();
  }
});

test("desktop capability projection: 合同里声明的每个 card_generation 动作位，owner 都必须被放行", () => {
  // 起因：`card_generation.retry` 在合同里声明、主进程 IPC 硬性校验它，但投影的
  // owner 放行清单漏了它——结果所有人点"重试生成"永远 forbidden。这类"声明了却
  // 忘了放行"的漂移不该靠人记住，所以按合同枚举反查。
  try {
    process.env.CARD_GENERATION_V2_ENABLED = "true";
    const declared = actionCapabilityValues.filter((capability) => capability.startsWith("card_generation."));
    assert.ok(declared.length >= 7, `合同里的 card_generation 动作位异常少：${declared.join(", ")}`);
    const projection = buildDesktopCapabilityProjection({ role: "owner", ai: mockOnlyAi , workspaceEpoch: 1 });
    for (const capability of declared) {
      assert.equal(
        projection.actionCapabilities[capability],
        "allowed",
        `${capability} 在合同里声明了，owner 却没被放行：投影漏了放行清单`,
      );
    }
  } finally {
    restoreFlags();
  }
});
