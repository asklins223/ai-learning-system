interface CalloutProps {
  title?: string;
  children: React.ReactNode;
  variant?: "default" | "blue" | "green" | "amber" | "red";
  className?: string;
}

export function Callout({ title, children, variant = "default", className = "" }: CalloutProps) {
  return (
    <div className={`callout ${variant} ${className}`}>
      {title && <h4>{title}</h4>}
      <p>{children}</p>
    </div>
  );
}
