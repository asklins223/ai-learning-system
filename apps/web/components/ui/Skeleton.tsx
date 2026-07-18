/** 加载骨架（V0.2 升级）。
 *  - 浅色矩形 + 极轻扫光，脉动
 *  - 不喧宾夺主
 */
export function Skeleton({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-breathe rounded-md bg-paper"
          style={{ width: `${[100, 80, 60][i % 3]}%` }}
        />
      ))}
    </div>
  );
}
