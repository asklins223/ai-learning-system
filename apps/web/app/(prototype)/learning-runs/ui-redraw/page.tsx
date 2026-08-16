import { Suspense } from "react";
import "@/app/styles/learning-run.css";
import "@/components/liquid-orb/liquid-orb.css";
import { LearningRunRedrawLab } from "@/features/learning-run/demo/LearningRunRedrawLab";

export default function LearningRunUiRedrawPage() {
  return (
    <Suspense fallback={<div className="learning-run-route-loading" role="status">正在准备学习界面…</div>}>
      <LearningRunRedrawLab />
    </Suspense>
  );
}
