import type { CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";

/**
 * 她对自己的称呼 —— 只有一份来源。
 *
 * 库里 `pet_profiles.name` 存的是用户起的名字（本机实测是「爱吃白饭的大肥鱼」），
 * 而伴星身边那十几处文字以前把 **Live2D 模型名** "Mao" 写死在字符串里：
 * 换了形态、改了名字，界面上每一句仍然叫她 Mao，包括消息署名、输入框标题、
 * 三颗按钮的 aria-label 和「正在来到书桌边」那条加载语。
 *
 * 推导顺序与伴星中心 `companion-center-surface.tsx:718` 那一条同源；那一处应当改成
 * 调用本函数（一行改动，那个文件并行会话在改，所以先留作移交）。在那之前，
 * **这里是唯一一份实现**，别处不要再抄第三份。
 *
 * 取不到人格时回"伴星"而不是回 "Mao"：拿不到名字不等于她叫模型名。
 */
export function companionDisplayName(persona: CompanionPersonaV1 | null): string {
  const profileName = (persona?.profile?.name ?? "").trim();
  if (profileName) return profileName;
  const presetName = (persona?.activePreset?.name ?? "").trim();
  if (presetName) return presetName;
  return "伴星";
}

type CompanionNameListener = (name: string) => void;
const nameListeners = new Set<CompanionNameListener>();

/**
 * 改了名字之后，让正在显示她名字的那几处当场换过来。
 *
 * 写的人是她，改的地方在伴星中心，读的地方在她身边（署名、轨道 aria-label、抽屉、
 * 加载语）。写入响应本来就带着**刚写进去的那一版档案**，所以这里直接播新名字，
 * 不让读侧重拉一遍——各自去拉就会出现"中心已经改了、气泡还叫旧名字"的两个来源。
 */
export function subscribeCompanionDisplayName(listener: CompanionNameListener): () => void {
  nameListeners.add(listener);
  return () => { nameListeners.delete(listener); };
}

export function publishCompanionDisplayName(name: string): void {
  for (const listener of [...nameListeners]) listener(name);
}
