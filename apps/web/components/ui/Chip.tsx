interface ChipProps {
  children: React.ReactNode;
  variant?: "default" | "blue" | "green" | "teal" | "amber" | "red";
  className?: string;
}

export function Chip({ children, variant = "default", className = "" }: ChipProps) {
  return (
    <span className={`chip ${variant} ${className}`}>
      {children}
    </span>
  );
}

export function ChipRow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`chip-row ${className}`}>
      {children}
    </div>
  );
}
