/**
 * 麦克风可用性探测（2026-09-20 实走复盘 #8）。
 *
 * 此前"能不能语音作答"的判断是恒真的：主进程只检查 IPC 通道名在不在一个静态
 * 常量集合里（`desktop-gateway.ts` 的 `nativeCapabilities()`），跟设备上有没有
 * 麦克风、用户给没给权限都无关，所以永远回答"可用"。用户点进去之后落进一段
 * 没有任何输入控件的死路文案，只能靠跳过或退出脱身。
 *
 * 这里做的是**不打开麦克风**的探测：`enumerateDevices()` 在没有权限时仍会列出
 * 输入设备，但 `label` 是空串。于是
 *   没有 API            → 这个 webview 不支持录音
 *   一个输入设备都没有    → 没插麦克风
 *   有设备但 label 全空   → 系统/页面还没拿到麦克风权限
 * 三种情况给出三种不同说法，而不是笼统一句"不可用"。
 *
 * 刻意不调用 `getUserMedia()` 做探测：那会真的开启麦克风（系统出现橙色指示灯），
 * 用一个隐私副作用去换取一个提示，不划算。真正的启动失败仍由录音侧兜底，
 * 届时 `reason` 用 `start-failed` 补上。
 */

export type MicrophoneAvailability =
  | { state: "ready" }
  | { state: "no-api" }
  | { state: "no-device" }
  | { state: "no-permission" }
  | { state: "start-failed"; errorName: string };

/** 面向用户的一句话原因；调用方负责把它摆在按钮旁边，而不是只写进 console。 */
export function microphoneAvailabilityCopy(availability: MicrophoneAvailability): string {
  switch (availability.state) {
    case "ready": return "";
    case "no-api": return "这个窗口不支持录音，请改用文本作答。";
    case "no-device": return "这台设备上没有检测到麦克风，插好或换一台之后再试；也可以直接用文本作答。";
    case "no-permission": return "还没有拿到麦克风权限。在系统设置的隐私 → 麦克风里允许本应用，或点浏览器地址栏的相机/麦克风图标授权。";
    case "start-failed": return `麦克风打不开（${availability.errorName}）。可以先用文本作答，稍后再试。`;
  }
}

export async function probeMicrophone(): Promise<MicrophoneAvailability> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { state: "no-api" };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    if (inputs.length === 0) return { state: "no-device" };
    if (inputs.every((device) => device.label === "")) return { state: "no-permission" };
    return { state: "ready" };
  } catch {
    // 探测本身失败（受限的 webview 等）：不谎报"没麦克风"，交给启动录音时的
    // 真实错误去说明，避免把环境问题说成用户设备问题。
    return { state: "no-api" };
  }
}
