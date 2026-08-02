import { useMemo } from "react";
import { fmtNum, fmtDate, type SessionDetail } from "../api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function ContextEventsTimeline({ detail }: { detail: SessionDetail }) {
  const events = detail.context_events;
  const maxPct = useMemo(() => {
    let m = 0;
    for (const e of events) {
      const v = e.context_usage_percent ?? 0;
      if (v > m) m = v;
    }
    return m;
  }, [events]);

  if (!events.length) return null;

  return (
    <Card className="rounded-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          Context events ({events.length})
          <Badge variant="outline" className="text-[10px]">
            {maxPct.toFixed(0)}% max
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {events.map((e) => {
            const pct = e.context_usage_percent ?? 0;
            const pctClamped = Math.min(100, Math.max(0, pct));
            const widthPct = pctClamped.toFixed(1);
            const high = pct >= 80;
            return (
              <div key={e.id} className="flex items-center gap-3 text-xs">
                <span className="font-mono tabular-nums w-16 text-muted-foreground">
                  {e.created_at ? fmtDate(e.created_at) : "—"}
                </span>
                <span className="font-mono tabular-nums w-20 text-right">
                  {fmtNum(e.context_tokens ?? 0)}
                </span>
                <div className="flex-1 bg-secondary relative h-3 overflow-hidden">
                  <div
                    className={
                      high
                        ? "absolute inset-y-0 left-0 bg-destructive/80"
                        : "absolute inset-y-0 left-0 bg-primary/70"
                    }
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span
                  className={
                    high
                      ? "font-mono tabular-nums w-14 text-right text-destructive font-semibold"
                      : "font-mono tabular-nums w-14 text-right text-muted-foreground"
                  }
                >
                  {pct.toFixed(0)}%
                </span>
                <span className="font-mono tabular-nums w-20 text-right text-muted-foreground">
                  / {fmtNum(e.context_window_size ?? 0)}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
