interface ContextItemProps {
  label: string;
  value: string;
}

function ContextItem({ label, value }: ContextItemProps) {
  return (
    <div className="context-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

interface ContextStripProps {
  items: ContextItemProps[];
  className?: string;
}

export function ContextStrip({ items, className = "" }: ContextStripProps) {
  return (
    <div className={`context-strip ${className}`}>
      {items.map((item, index) => (
        <ContextItem key={index} label={item.label} value={item.value} />
      ))}
    </div>
  );
}
