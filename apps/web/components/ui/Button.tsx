interface ButtonProps {
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}

export function Button({ 
  children, 
  variant = "primary", 
  onClick, 
  className = "",
  disabled = false 
}: ButtonProps) {
  return (
    <button 
      type="button"
      className={`button ${variant === "secondary" ? "button-secondary" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function SearchField({ placeholder = "搜索...", className = "" }: { placeholder?: string; className?: string }) {
  return (
    <div className={`search-field ${className}`}>
      {placeholder}
    </div>
  );
}
