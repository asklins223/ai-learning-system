import { redirect } from "next/navigation";

/**
 * UI redraw 的生成设置已并入 NoteEditor 的 V2 生成流程；
 * 学习卡库入口统一到生产 /cards。
 */
export default function LearningCardsUiRedrawRedirect() {
  redirect("/cards");
}
