// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  motionSpecKey,
  parseWindowLive2DCatalog,
  type Expression3File,
  type Model3File,
  type Motion3File,
} from "./live2d-performance-catalog";
import {
  WINDOW_LIVE2D_MODEL_REGISTRY,
  isFaceLayerLive2DParameter,
  type WindowLive2DModelId,
} from "./window-live2d-contract";

/**
 * 用仓库里的**真资产**核对"每个形态接入了多少动作和表情"。
 *
 * 手写表会漏，而漏掉的那部分永远没人看得见（2026-09-20 用户："你真的有接入全部
 * 动作和表情吗"）。这里断言的是资产与清单的一致性：model3.json 里声明的东西，
 * 表演清单里必须一条不少；情绪表里写到的表情名，资产里必须真有。
 */

// 走 Vite 的 glob 而不是 node:fs：渲染进程的类型工程里没有 node 类型。
const assets = import.meta.glob("../../../public/assets/companion/**/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

/** 按结尾路径取一个资产（表达式文件的文件名可能是中文）。 */
function readAsset(suffix: string): unknown {
  const key = Object.keys(assets).find((path) => path.endsWith(suffix));
  if (!key) throw new Error(`Missing bundled asset: ${suffix}`);
  return assets[key];
}

function catalogOf(modelId: WindowLive2DModelId) {
  const descriptor = WINDOW_LIVE2D_MODEL_REGISTRY[modelId];
  const model3 = readAsset(descriptor.model.split("/").pop() as string) as Model3File;
  const expressions = (model3.FileReferences?.Expressions ?? []).filter(
    (entry): entry is { Name: string; File: string } =>
      typeof entry?.Name === "string" && typeof entry?.File === "string",
  );
  const motionFiles = new Map<string, Motion3File>();
  for (const [group, entries] of Object.entries(model3.FileReferences?.Motions ?? {})) {
    (entries ?? []).forEach((entry, index) => {
      if (typeof entry?.File !== "string") return;
      motionFiles.set(motionSpecKey(group, index), readAsset(entry.File) as Motion3File);
    });
  }
  return parseWindowLive2DCatalog(
    model3,
    new Map(expressions.map((entry) => [
      entry.Name,
      readAsset(entry.File.split("/").pop() as string) as Expression3File,
    ])),
    motionFiles,
    descriptor.presentationMotion.idle?.group,
    new Map(Object.entries(descriptor.propRoles)),
  );
}

describe("Live2D 表演清单来自各形态自己的资产", () => {
  const mao = catalogOf("mao-pro");
  const whale = catalogOf("whale");
  const seethrough = catalogOf("seethrough");

  it("mao：默认组 6 条编排动作 + 有内容的 7 个表情在表演池里", () => {
    const motions = mao.performanceCues.filter((cue) => cue.kind === "motion");
    const expressions = mao.performanceCues.filter((cue) => cue.kind === "expression");
    expect(motions.map((cue) => (cue.kind === "motion" ? cue.cue : null))).toEqual(
      [0, 1, 2, 3, 4, 5].map((index) => ({ group: "", index })),
    );
    expect(expressions.map((cue) => (cue.kind === "expression" ? cue.name : null))).toEqual([
      "exp_02", "exp_03", "exp_04", "exp_05", "exp_06", "exp_07", "exp_08",
    ]);
    // 唯一被丢掉的声明是 exp_01：它每个参数写的都是中性值，演出来等于站着不动。
    expect(mao.expressionParameters.exp_01?.size).toBe(0);
  });

  it("大肥鱼：5 条动作组除 Idle 外全部进池，30 个表情分成 14 张脸 + 16 件道具", () => {
    expect(whale.performanceCues.filter((cue) => cue.kind === "motion")
      .map((cue) => (cue.kind === "motion" ? cue.cue.group : null)))
      .toEqual(["Bubble", "Spray", "Selfie", "SelfieQuick"]);
    expect(whale.performanceCues.filter((cue) => cue.kind === "expression")
      .map((cue) => (cue.kind === "expression" ? cue.name : null))).toEqual([
      "happy", "starstruck", "heart-eyes", "blush", "mischievous", "sweat", "dizzy",
      "angry", "sad", "cry", "dazed", "drool", "gloomy", "tongue",
    ]);
    expect(whale.performanceCues.filter((cue) => cue.kind === "prop")).toHaveLength(16);
    expect(whale.hasMotionGroup("Idle")).toBe(false);
    expect(whale.hasMotionGroup("Spray")).toBe(true);
  });

  it("大肥鱼的道具都是可开关的装饰：只登记 Add 写入，且至少动一个装饰参数", () => {
    // 眼镜/贴纸挂在道具通道上，靠的就是"它开一块美术网格的可见性"。
    // 墨镜那张顺带把眼睛画成一条线（Add -1）：道具层按规则跳过脸部参数，
    // 所以她戴墨镜时眼睛还是睁着的——眼镜框本身就该盖住眼睛，不影响读。
    for (const name of Object.keys(WINDOW_LIVE2D_MODEL_REGISTRY.whale.propRoles)) {
      const writes = whale.expressionWrites[name];
      expect(writes.length, `${name} 在资产里没有任何写入`).toBeGreaterThan(0);
      for (const write of writes) {
        expect(write.blend, `${name}.${write.parameter} 不是 Add 混合`).toBe("Add");
      }
      expect(
        writes.some((write) => !isFaceLayerLive2DParameter(write.parameter)),
        `${name} 没有任何装饰参数，不该登记成道具`,
      ).toBe(true);
    }
    // 具体到值：圆眼镜开 ParamCheek70，爱心开 love，比耶开 phone7。
    expect(whale.expressionWrites["glasses-round"]).toEqual([
      { parameter: "ParamCheek70", value: 1, blend: "Add" },
    ]);
    expect(whale.expressionWrites.hearts).toEqual([
      { parameter: "love", value: 1, blend: "Add" },
    ]);
    expect(whale.expressionWrites.peace).toEqual([
      { parameter: "phone7", value: 1, blend: "Add" },
    ]);
  });

  it("动作清单带真实时长与自己动的参数（演完要收回手机和喷水）", () => {
    const spray = whale.motionSpecs[motionSpecKey("Spray", 0)];
    expect(spray.parameters).toEqual(["pengshui"]);
    expect(spray.durationMs).toBeCloseTo(467, 0);

    const selfie = whale.motionSpecs[motionSpecKey("Selfie", 0)];
    // 自拍把手机举起来了：`phone` 归它，idle 动作不碰，所以必须能被告警重置层收回。
    expect(selfie.parameters).toContain("phone");
    expect(whale.idleMotionParameters.has("phone")).toBe(false);
    expect(selfie.durationMs).toBeGreaterThan(3_000);
  });

  it("时刻表引用的动作组与道具名，资产里必须真有", () => {
    for (const [modelId, descriptor] of Object.entries(WINDOW_LIVE2D_MODEL_REGISTRY)) {
      const catalog = modelId === "mao-pro" ? mao : modelId === "whale" ? whale : seethrough;
      for (const [moment, cue] of Object.entries(descriptor.momentCue)) {
        if (cue?.motion) {
          expect(catalog.hasMotionGroup(cue.motion.group), `${modelId}.${moment} 的动作组`)
            .toBe(true);
        }
        for (const prop of [cue?.costume, cue?.overlay]) {
          if (typeof prop !== "string") continue;
          expect(prop in descriptor.propRoles, `${modelId}.${moment} 的 ${prop} 不是已登记道具`)
            .toBe(true);
          expect(catalog.expressionWrites[prop]?.length, `${modelId}.${prop} 资产里读不到`)
            .toBeGreaterThan(0);
        }
      }
    }
  });

  it("小彩：8 组语义动作里除 Idle 外全部进池，且它确实没有 exp3 表情", () => {
    expect(seethrough.performanceCues.map((cue) => (cue.kind === "motion" ? cue.cue.group : null)))
      .toEqual(["Blink", "Nod", "Shake", "Think", "Happy", "Surprised", "Sleepy"]);
    expect(seethrough.performanceCues).toHaveLength(7);
  });

  it("每个形态声明的动作/表情 = 表演池 + 被丢掉的空表情（一条都不静默丢）", () => {
    for (const [name, catalog, model3Path] of [
      ["mao", mao, "live2d-v1/mao-pro/runtime/mao_pro.model3.json"],
      ["大肥鱼", whale, "live2d-v3/whale/c_0120.model3.json"],
      ["小彩", seethrough, "live2d-v2/seethrough/seethrough_output.model3.json"],
    ] as const) {
      const model3 = readAsset(model3Path) as Model3File;
      const declaredMotions = Object.entries(model3.FileReferences?.Motions ?? [])
        .filter(([group]) => group !== "Idle")
        .reduce((total, [, entries]) => total + (entries?.length ?? 0), 0);
      const declaredExpressions = (model3.FileReferences?.Expressions ?? [])
        .map((entry) => entry?.Name)
        .filter((name): name is string => typeof name === "string");
      const pooled = catalog.performanceCues
        .map((cue) => (cue.kind === "motion" ? "" : cue.name))
        .filter((name) => name.length > 0);
      const dropped = declaredExpressions.filter((entry) => !pooled.includes(entry));
      // 只允许丢掉"写了 0 个非中性参数"的表情，其余必须全部进池。
      for (const entry of dropped) {
        expect(catalog.expressionParameters[entry]?.size ?? 0, `${name}.${entry}`).toBe(0);
      }
      expect(declaredMotions + pooled.length + dropped.length)
        .toBe(declaredMotions + declaredExpressions.length);
      expect(catalog.performanceCues.length).toBe(declaredMotions + pooled.length);
    }
  });

  it("情绪表情表里的名字，资产里必须真有这个表情", () => {
    const catalogs = {
      "mao-pro": mao,
      whale,
      seethrough,
    } as const;
    for (const [modelId, descriptor] of Object.entries(WINDOW_LIVE2D_MODEL_REGISTRY)) {
      const catalog = catalogs[modelId as keyof typeof catalogs];
      const dead = Object.values(descriptor.emotionExpression).filter(
        (name) => !catalog.hasExpression(name),
      );
      expect(dead, `${modelId} 引用了资产里不存在的表情`).toEqual([]);
    }
  });

  it("表情写过的参数由表情接管；中性写入的不接管", () => {
    // mao 每个 exp3 都把全部参数列一遍，中性值不能算接管，否则眨眼/口型会被禁掉。
    expect(mao.expressionParameters.exp_01?.size).toBe(0);
    expect(mao.expressionParameters.exp_02).toEqual(new Set(["ParamEyeLOpen", "ParamEyeLSmile", "ParamEyeROpen", "ParamEyeRSmile"]));
    // Multiply 0（mao exp_02 的眯眼笑）算接管；Add 0（大肥鱼 happy 的眼睛）在 Cubism
    // 的加法混合下本来就是 no-op，不该因此把眨眼禁掉。Add -1（mischievous 的单眼眨）算接管。
    expect(whale.expressionParameters.happy?.has("ParamEyeLOpen")).toBe(false);
    expect(whale.expressionParameters.mischievous?.has("ParamEyeROpen")).toBe(true);
    expect(whale.expressionParameters.surprised?.size).toBe(1);
    // 小彩没有表情：没有任何参数被接管，眨眼/FACS 照常。
    expect(Object.keys(seethrough.expressionParameters)).toEqual([]);
  });
});
