import { describe, expect, it } from "vitest";
import {
  WINDOW_LIVE2D_ASSETS,
  WINDOW_LIVE2D_MODEL_REGISTRY,
  WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS,
  WindowLive2DPerformanceRotation,
  expressionForWindowLive2DEmotion,
  isApprovedWindowLive2DManifest,
  isWindowLive2DModelId,
  motionForWindowLive2DEmotion,
  motionForWindowLive2D,
  momentCueForWindowLive2D,
  parameterValuesForWindowLive2D,
  presentationForCharacterCueIntent,
  propParameterValuesForWindowLive2D,
} from "./window-live2d-contract";

/** 读一个参数，省掉每个用例都写一遍 find。 */
function parameterValue(
  values: readonly { readonly parameter: string; readonly value: number }[],
  parameter: string,
): number | undefined {
  return values.find((value) => value.parameter === parameter)?.value;
}

describe("window Live2D policy", () => {
  it("fails closed when bundled model license approval is absent", () => {
    const approved = {
      schemaVersion: 1,
      modelId: "companion-live2d-mao-pro-v1",
      status: "production",
      ownerApproved: { by: "Owner", date: "2026-08-11" },
      modelLicense: {
        name: "Live2D Free Material License Agreement and Terms of Use",
        acceptanceRequired: true,
        commercialReleaseAllowed: true,
      },
    };
    const MAO = WINDOW_LIVE2D_MODEL_REGISTRY["mao-pro"].manifestExpectation;
    expect(isApprovedWindowLive2DManifest(approved, MAO)).toBe(true);
    expect(isApprovedWindowLive2DManifest({ ...approved, ownerApproved: null }, MAO)).toBe(false);
    expect(isApprovedWindowLive2DManifest({
      ...approved,
      modelLicense: { ...approved.modelLicense, commercialReleaseAllowed: false },
    }, MAO)).toBe(false);
    // 缺省验收要求 = 当前默认形态（2026-09-20 起是大肥鱼），mao 的 manifest 通不过它。
    expect(isApprovedWindowLive2DManifest(approved)).toBe(false);

    // 逐模型校验（2026-09-20 多形态）：seethrough 的开发态 manifest 即使带完整
    // ownerApproved 字段，也通不过 mao / whale 的验收要求（modelId / status 不匹配）。
    expect(isApprovedWindowLive2DManifest({
      schemaVersion: 1,
      modelId: "companion-live2d-seethrough-v2",
      status: "development",
      ownerApproved: { by: "User", date: "2026-09-15" },
      modelLicense: {
        name: "User-provided artwork; license confirmation required before redistribution",
        acceptanceRequired: true,
        commercialReleaseAllowed: false,
      },
    })).toBe(false);
  });

  it("approves each registered model against its own manifest expectation", () => {
    for (const descriptor of Object.values(WINDOW_LIVE2D_MODEL_REGISTRY)) {
      const approved = {
        schemaVersion: 1,
        modelId: descriptor.manifestExpectation.modelId,
        status: descriptor.manifestExpectation.status,
        ownerApproved: { by: "Owner", date: "2026-09-20" },
        modelLicense: {
          name: "license",
          acceptanceRequired: true,
          commercialReleaseAllowed: descriptor.manifestExpectation.commercialReleaseAllowed,
        },
      };
      expect(isApprovedWindowLive2DManifest(approved, descriptor.manifestExpectation)).toBe(true);
      // modelId 混用 fail closed：whale 的 manifest 不能通过 mao 的校验，反之亦然。
      const other = descriptor === WINDOW_LIVE2D_MODEL_REGISTRY["mao-pro"]
        ? WINDOW_LIVE2D_MODEL_REGISTRY.whale
        : WINDOW_LIVE2D_MODEL_REGISTRY["mao-pro"];
      expect(isApprovedWindowLive2DManifest(approved, other.manifestExpectation)).toBe(false);
    }
    expect(isWindowLive2DModelId("mao-pro")).toBe(true);
    expect(isWindowLive2DModelId("whale")).toBe(true);
    expect(isWindowLive2DModelId("seethrough")).toBe(true);
    expect(isWindowLive2DModelId("orb")).toBe(false);
  });

  it("maps seethrough onto its own semantic motion groups", () => {
    expect(motionForWindowLive2D("idle", "seethrough")).toEqual({ group: "Idle", index: 0 });
    expect(motionForWindowLive2D("invite", "seethrough")).toEqual({ group: "Nod", index: 0 });
    expect(motionForWindowLive2D("uncertain", "seethrough")).toEqual({ group: "Shake", index: 0 });
    expect(motionForWindowLive2D("think", "seethrough")).toEqual({ group: "Think", index: 0 });
    expect(motionForWindowLive2D("celebrate", "seethrough")).toEqual({ group: "Happy", index: 0 });
    expect(motionForWindowLive2DEmotion("happy", "seethrough")).toEqual({ group: "Happy", index: 0 });
    expect(motionForWindowLive2DEmotion("surprised", "seethrough")).toEqual({ group: "Surprised", index: 0 });
    expect(motionForWindowLive2DEmotion("sad", "seethrough")).toEqual({ group: "Sleepy", index: 0 });
    // seethrough 没有 exp3 表情文件：情绪表情恒空，走动作 + FACS 路径。
    expect(expressionForWindowLive2DEmotion("happy", "seethrough")).toBeNull();
    expect(WINDOW_LIVE2D_MODEL_REGISTRY.seethrough.lipSyncParameter).toBe("ParamMouthOpenY");
  });

  it("maps whale to its own motion groups and expressions", () => {
    expect(motionForWindowLive2D("idle", "whale")).toEqual({ group: "Idle", index: 0 });
    expect(motionForWindowLive2D("invite", "whale")).toBeNull();
    expect(motionForWindowLive2DEmotion("happy", "whale")).toBeNull();
    expect(expressionForWindowLive2DEmotion("happy", "whale")).toBe("happy");
    expect(expressionForWindowLive2DEmotion("surprised", "whale")).toBe("surprised");
    expect(expressionForWindowLive2DEmotion("neutral", "whale")).toBeNull();
    // mao 的自带 exp3 也接上了（2026-09-20：exp3 一直在资产里，代码没接）。
    expect(expressionForWindowLive2DEmotion("happy", "mao-pro")).toBe("exp_02");
    expect(expressionForWindowLive2DEmotion("angry", "mao-pro")).toBe("exp_08");
    expect(expressionForWindowLive2DEmotion("neutral", "mao-pro")).toBeNull();
  });

  it("表演池轮播：一袋之内不重复，重洗后不接上一条", () => {
    const pool = ["a", "b", "c", "d", "e", "f"].map((name) => ({
      kind: "expression" as const,
      name,
    }));
    const rotation = new WindowLive2DPerformanceRotation(pool);
    const drawn = Array.from({ length: pool.length + 1 }, () => rotation.next()!);
    const firstBag = drawn.slice(0, pool.length);

    // 抽完整袋 = 全部条目各演一次，不存在"几个月演不到一次"的动作。
    expect(firstBag.map((cue) => (cue.kind === "expression" ? cue.name : ""))
      .sort()).toEqual(pool.map((cue) => cue.name).sort());
    // 上一袋的尾巴和本袋的开头不会是同一条（连着两条一样会被读成"卡带"）。
    expect(drawn[pool.length]).not.toBe(drawn[pool.length - 1]);
    expect(new WindowLive2DPerformanceRotation([]).next()).toBeNull();
  });

  it("表情写过的参数在表情有效期间不再被眨眼/FACS 覆盖", () => {
    const owned = new Set(["ParamEyeLOpen", "ParamEyeROpen", "ParamMouthUp"]);
    const values = parameterValuesForWindowLive2D({
      presentation: "celebrate",
      nowMs: 1_000,
      voiceLevel: 0,
      emotion: { emotion: "happy", intensity: 1 },
      expressionOwnedParameters: owned,
    });

    expect(values.some((value) => value.parameter === "ParamEyeLOpen")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamEyeROpen")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamMouthUp")).toBe(false);
    // 眉毛 FACS 与呼吸不在这张表情里，照常写。
    expect(values.some((value) => value.parameter === "ParamBrowLY")).toBe(true);
    expect(values.some((value) => value.parameter === "ParamBreath")).toBe(true);
    // 说话时口型不放手：嘴要跟着声音动，静态嘴形让位。
    expect(parameterValuesForWindowLive2D({
      presentation: "speak", nowMs: 1_000, voiceLevel: 0.6, expressionOwnedParameters: owned,
    }).some((value) => value.parameter === "ParamMouthUp")).toBe(true);
    // 没有表情时一切照旧。
    expect(parameterValuesForWindowLive2D({
      presentation: "idle", nowMs: 1_000, voiceLevel: 0,
    }).some((value) => value.parameter === "ParamEyeLOpen")).toBe(true);
  });

  it("writes whale lipsync into ParamMouthOpenY instead of ParamA", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "speak",
      nowMs: 1_000,
      voiceLevel: 0.6,
      lipSyncParameter: WINDOW_LIVE2D_MODEL_REGISTRY.whale.lipSyncParameter,
    });
    expect(values.find((value) => value.parameter === "ParamMouthOpenY")?.value).toBeCloseTo(0.6);
    expect(values.some((value) => value.parameter === "ParamA")).toBe(false);
  });

  it("只声明 Live2D 资产：orb / 替身立绘已随 2026-09-16 裁决移除", () => {
    const assetPaths = [
      WINDOW_LIVE2D_ASSETS.manifest,
      WINDOW_LIVE2D_ASSETS.model,
      ...WINDOW_LIVE2D_ASSETS.vendorScripts,
    ];
    expect(Object.keys(WINDOW_LIVE2D_ASSETS)).toEqual([
      "manifest",
      "model",
      "vendorScripts",
    ]);
    for (const path of assetPaths) {
      expect(path).not.toContain("orb");
      expect(path).not.toContain("half-idle");
    }
  });

  it("maps the public presentation contract to the exported PSD2Live motion groups", () => {
    // 这些是 mao 的编排映射；不依赖"哪个形态是默认"（默认已改成大肥鱼）。
    expect(motionForWindowLive2D("idle", "mao-pro")).toEqual({ group: "Idle", index: 0 });
    expect(motionForWindowLive2D("invite", "mao-pro")).toEqual({ group: "", index: 0 });
    expect(motionForWindowLive2D("think", "mao-pro")).toEqual({ group: "", index: 2 });
    expect(motionForWindowLive2D("celebrate", "mao-pro")).toEqual({ group: "", index: 3 });
    expect(motionForWindowLive2D("uncertain", "mao-pro")).toEqual({ group: "", index: 1 });
    expect(motionForWindowLive2D("hidden", "mao-pro")).toBeNull();
    expect(motionForWindowLive2DEmotion("excited", "mao-pro")).toEqual({ group: "", index: 3 });
    expect(motionForWindowLive2DEmotion("surprised", "mao-pro")).toEqual({ group: "", index: 1 });
    expect(motionForWindowLive2DEmotion("neutral", "mao-pro")).toBeNull();
  });

  it("clamps external voice amplitude before it reaches Cubism Core", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "speak",
      nowMs: 1_000,
      voiceLevel: 12,
    });

    expect(values.find((value) => value.parameter === "ParamA")?.value).toBe(1);
    expect(values.every((value) => Number.isFinite(value.value))).toBe(true);
  });

  it("lets an emotion own FACS while lipsync still owns the mouth", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "celebrate",
      nowMs: 1_000,
      voiceLevel: 0.75,
      emotion: { emotion: "concerned", intensity: 0.5 },
    });

    expect(values.find((value) => value.parameter === "ParamMouthUp")?.value).toBeCloseTo(0.15);
    expect(values.find((value) => value.parameter === "ParamA")?.value).toBeCloseTo(0.75);
  });

  it("does not inject Seethrough-only parameters into Mao", () => {
    const values = parameterValuesForWindowLive2D({
      presentation: "idle",
      nowMs: 1_000,
      voiceLevel: 0,
      emotion: null,
    });

    expect(values.some((value) => value.parameter === "ParamMouthOpenY")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamMouthForm")).toBe(false);
    expect(values.some((value) => value.parameter === "ParamA")).toBe(false);
  });

  describe("「看向手边」（方案 §5 第 9 项）", () => {
    const idleBodyAngleX = (nowMs: number) => Math.sin(nowMs / 2_400) * 2;

    it("没有冲量时 ParamBodyAngleX 逐帧等于静息摇摆（本次改动不改变既有画面）", () => {
      for (const nowMs of [0, 600, 1_000, 2_400, 5_000]) {
        const values = parameterValuesForWindowLive2D({
          presentation: "idle",
          nowMs,
          voiceLevel: 0,
        });
        expect(parameterValue(values, "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(nowMs));
      }
    });

    it("工具刚开始执行时侧身 3 度，并在 1.5s 内二次缓出回到静息值", () => {
      const atMs = 0;
      // 起点：冲量满幅，静息摇摆此刻正好是 0。
      expect(parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: 0, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX")).toBeCloseTo(-3);

      // 中点：(1 - 0.5)^2 = 0.25，偏移收窄到 -0.75。
      const half = WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS / 2;
      expect(parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: half, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(half) - 0.75);
    });

    it("冲量窗口结束时与静息摇摆严丝合缝，不会回弹", () => {
      const atMs = 0;
      const lastFrame = WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS - 1;
      const atEnd = parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle", nowMs: lastFrame, voiceLevel: 0, toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX");
      const afterEnd = parameterValue(parameterValuesForWindowLive2D({
        presentation: "idle",
        nowMs: WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS,
        voiceLevel: 0,
        toolAttentionAtMs: atMs,
      }), "ParamBodyAngleX");

      expect(atEnd).toBeCloseTo(idleBodyAngleX(lastFrame), 3);
      expect(afterEnd).toBeCloseTo(idleBodyAngleX(WINDOW_LIVE2D_TOOL_ATTENTION_DURATION_MS));
    });

    it("未来时间戳与非有限值都当作没有冲量，不写入非法参数", () => {
      for (const toolAttentionAtMs of [Number.NaN, Number.POSITIVE_INFINITY, 4_000]) {
        const values = parameterValuesForWindowLive2D({
          presentation: "idle", nowMs: 1_000, voiceLevel: 0, toolAttentionAtMs,
        });
        expect(parameterValue(values, "ParamBodyAngleX")).toBeCloseTo(idleBodyAngleX(1_000));
        expect(values.every((value) => Number.isFinite(value.value))).toBe(true);
      }
    });

    it("冲量不与口型/表情抢参数：它只动 ParamBodyAngleX", () => {
      const withImpulse = parameterValuesForWindowLive2D({
        presentation: "speak", nowMs: 0, voiceLevel: 0.6, toolAttentionAtMs: 0,
      });
      expect(parameterValue(withImpulse, "ParamA")).toBeCloseTo(0.6);
      expect(parameterValue(withImpulse, "ParamBodyAngleX")).toBeCloseTo(-3);
    });
  });

  it("每条 cue 的 intent 都落到一个姿势，服务端说的和身体做的不再两套话", () => {
    expect(presentationForCharacterCueIntent("think")).toBe("think");
    expect(presentationForCharacterCueIntent("explain")).toBe("speak");
    expect(presentationForCharacterCueIntent("listen")).toBe("listen");
    expect(presentationForCharacterCueIntent("acknowledge")).toBe("invite");
    expect(presentationForCharacterCueIntent("encourage")).toBe("encourage");
    expect(presentationForCharacterCueIntent("celebrate")).toBe("celebrate");
    expect(presentationForCharacterCueIntent("uncertain")).toBe("uncertain");
    expect(presentationForCharacterCueIntent("warn")).toBe("uncertain");
    expect(presentationForCharacterCueIntent("sleep")).toBe("idle");
    // 协议之外的值不猜姿势。
    expect(presentationForCharacterCueIntent("party" as never)).toBeNull();
    expect(presentationForCharacterCueIntent(null)).toBeNull();
  });

  it("任务时刻各有表演：接活戴眼镜、成功比耶、失败吐魂、等确认冒问号、收工摘眼镜", () => {
    expect(momentCueForWindowLive2D("working", "whale")).toEqual({ costume: "glasses-round" });
    expect(momentCueForWindowLive2D("tool_succeeded", "whale")).toEqual({
      motion: { group: "Bubble", index: 0 },
      overlay: "peace",
      costume: null,
      holdMs: 3_000,
    });
    expect(momentCueForWindowLive2D("tool_failed", "whale")?.overlay).toBe("soul");
    expect(momentCueForWindowLive2D("run_failed", "whale")?.overlay).toBe("soul");
    expect(momentCueForWindowLive2D("awaiting_confirmation", "whale")?.overlay).toBe("question");
    expect(momentCueForWindowLive2D("reminder", "whale")?.overlay).toBe("surprised");
    expect(momentCueForWindowLive2D("task_started", "whale")?.motion)
      .toEqual({ group: "Spray", index: 0 });
    // 一轮说完必须把眼镜摘下来，否则一副圆脸眼镜挂到下次切换形态。
    expect(momentCueForWindowLive2D("reply_completed", "whale")).toEqual({ costume: null });
    // 另外两个形态没有配件，只能演动作；没登记的时刻就是没有反应（不硬凑）。
    expect(momentCueForWindowLive2D("tool_succeeded", "mao-pro")?.motion)
      .toEqual({ group: "", index: 3 });
    expect(momentCueForWindowLive2D("tool_failed", "seethrough")?.motion)
      .toEqual({ group: "Shake", index: 0 });
    expect(momentCueForWindowLive2D("reminder", "seethrough")?.overlay).toBeUndefined();
  });

  it("道具层：穿着写资产值，脱了写 0，脸部参数与表情自己的参数都不碰", () => {
    const declared = {
      "glasses-round": [{ parameter: "ParamCheek70", value: 1, blend: "Add" }],
      flowers: [{ parameter: "ParamCheek26", value: 360, blend: "Add" }],
      "闭眼式": [{ parameter: "ParamEyeLOpen", value: 0, blend: "Add" }],
      mixed: [{ parameter: "ParamCheek81", value: 1, blend: "Multiply" }],
    };
    const wearing = propParameterValuesForWindowLive2D({
      costume: declared["glasses-round"],
      overlay: declared.flowers,
      declared,
    });
    expect(wearing.find((value) => value.parameter === "ParamCheek70")?.value).toBe(1);
    // 作者写多少就是多少（花是绕圈的旋转参数），不折成 0..1。
    expect(wearing.find((value) => value.parameter === "ParamCheek26")?.value).toBe(360);
    // 闭眼参数永远不进道具层，Multiply 的装饰也不（它要乘的是别人的底值）。
    expect(wearing.some((value) => value.parameter === "ParamEyeLOpen")).toBe(false);
    expect(wearing.some((value) => value.parameter === "ParamCheek81")).toBe(false);

    const naked = propParameterValuesForWindowLive2D({ costume: null, overlay: null, declared });
    // 没穿的写 0：这样才收得回去。
    expect(naked.find((value) => value.parameter === "ParamCheek70")?.value).toBe(0);
    // 脸上那张表情自己写了感叹号，道具层就不抢同一个参数。
    const reserved = propParameterValuesForWindowLive2D({
      costume: null,
      overlay: null,
      declared: { surprised: [{ parameter: "ParamCheek75", value: 1, blend: "Add" }] },
      reservedParameters: new Set(["ParamCheek75"]),
    });
    expect(reserved).toEqual([]);
  });
});
