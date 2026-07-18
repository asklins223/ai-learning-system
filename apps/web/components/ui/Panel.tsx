import { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
}

interface PanelHeaderProps {
  title: string;
  subtitle?: string;
  accent?: "blue" | "green" | "amber" | "red";
  actions?: ReactNode;
}

interface PanelBodyProps {
  children: ReactNode;
  tight?: boolean;
}

export function Panel({ children, className = "" }: PanelProps) {
  return (
    <div className={`panel ${className}`}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, subtitle, accent, actions }: PanelHeaderProps) {
  return (
    <div className={`panel-header ${accent ? `accent-${accent}` : ""}`}>
      <div>
        <h3 className="panel-title">{title}</h3>
        {subtitle && <p className="panel-subtitle">{subtitle}</p>}
      </div>
      {actions && <div>{actions}</div>}
    </div>
  );
}

export function PanelBody({ children, tight = false }: PanelBodyProps) {
  return (
    <div className={tight ? "panel-body-tight" : "panel-body"}>
      {children}
    </div>
  );
}
