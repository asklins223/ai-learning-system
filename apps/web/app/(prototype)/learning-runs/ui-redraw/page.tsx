import { redirect } from "next/navigation";

/**
 * UI redraw 已并入生产 LearningRun 流程；统一入口为 /learning-runs/new。
 */
export default function LearningRunUiRedrawRedirect() {
  redirect("/learning-runs/new");
}
