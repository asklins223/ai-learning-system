import { ReactNode } from "react";

/**
 * Surface — 规范 §6.1 表面类型组件。
 *
 * 变体：
 * - control：干净暖白、低纹理（导航、表单、筛选、设置）
 * - paper：纸白、轻颗粒、完整阴影（学习卡、笔记正文、复习题）
 * - evidence：暖白 + 蓝色线索（引用、证据列表）
 */
export function Surface({
  variant = "control",
  children,
  className = "",
  ...props
}: {
  variant?: "control" | "paper" | "evidence";
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const base = {
    control: "bg-surface rounded-lg border border-border",
    paper: "bg-paper rounded-lg shadow-paper border border-border",
    evidence: "bg-surface rounded-lg border border-evidence/30",
  }[variant];

  return (
    <div className={`${base} ${className}`} {...props}>
      {children}
    </div>
  );
}
