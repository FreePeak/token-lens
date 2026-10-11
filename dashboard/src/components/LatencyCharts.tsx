import { useEffect, useMemo, useState } from "react";
import {
  api,
  fmtLatency,
  fmtNum,
  type LatencyByTool,
  type LatencyStats,
} from "../api";
import { BarList } from "./BarList";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "./Stat";

function percentileBadges(s: LatencyStats): Array<{ label: string; value: string }> {
  return [
    { label: "p50", value: fmtLatency(s.p50_ms) },
    { label: "p90", value: fmtLatency(s.p90_ms) },
    { label: "p99", value: fmtLatency(s.p99_ms) },
    { label: "max", value: fmtLatency(s.max_ms) },
  ];
}

export function LatencyCharts({
  days,
  profile,
  onError,
}: {
  days?: number;
  profile?: string;
  onError: (e: string | null) => void;
}) {
  const [stats, setStats] = useState<LatencyStats | null>(null);
  const [byTool, setByTool] = useState<LatencyByTool[]>([]);

  useEffect(() => {
    onError(null);
    Promise.all([api.latency(days, profile), api.latencyByTool(days, profile)])
      .then(([s, t]) => {
        setStats(s);
        setByTool(t.slice(0, 10));
      })
      .catch((e) => onError(String(e)));
  }, [days, profile, onError]);

  const totalTime = useMemo(
    () => fmtLatency(stats?.total_ms ?? 0),
    [stats],
  );

  if (!stats) return <p className="text-muted-foreground p-4">Loading...</p>;

  return (
    <div className="animate-fade-in space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="Tool calls" value={fmtNum(stats.tool_calls)} />
        <Stat label="Failures" value={fmtNum(stats.failures)} />
        <Stat label="Time in tools" value={totalTime} />
        <Stat label="Avg ttfb" value={fmtLatency(stats.avg_ttfb_ms)} />
        <Stat
          label="Failure rate"
          value={
            stats.tool_calls
              ? `${((stats.failures / stats.tool_calls) * 100).toFixed(1)}%`
              : "—"
          }
        />
      </div>

      <Card className="rounded-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Tool latency percentiles</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6">
          {percentileBadges(stats).map((p) => (
            <div key={p.label} className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {p.label}
              </span>
              <span className="font-mono text-lg tabular-nums">{p.value}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            Slowest tools by total time
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BarList
            rows={byTool.map((r) => ({
              label: r.tool_name,
              value: r.total_ms,
              display: `${fmtLatency(r.total_ms)} · p50 ${fmtLatency(r.p50_ms)}`,
            }))}
          />
          {!byTool.length && <p className="text-sm text-muted-foreground">No data.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
