import { cn } from "@/lib/utils";

export function BarList({
  rows,
}: {
  rows: Array<{ label: string; value: number; display: string }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div className="bar-row" key={`${i}-${r.label}`}>
          <span
            className={cn("truncate text-muted-foreground", r.label.length > 48 && "text-xs")}
            title={r.label}
          >
            {r.label.length > 48 ? `${r.label.slice(0, 46)}…` : r.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
            {r.display}
          </span>
        </div>
      ))}
      {!rows.length && <p className="text-sm text-muted-foreground py-2">No data</p>}
    </div>
  );
}
