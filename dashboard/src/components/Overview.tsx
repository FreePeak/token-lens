import { useEffect, useState } from "react";
import { api, fmtCost, fmtNum, type DriverRow, type OverviewStats } from "../api";
import { Stat } from "./Stat";
import { BarList } from "./BarList";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function Overview({
  days,
  profile,
  onError,
}: {
  days?: number;
  profile?: string;
  onError: (e: string | null) => void;
}) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [byModel, setByModel] = useState<DriverRow[]>([]);
  const [byTool, setByTool] = useState<DriverRow[]>([]);

  useEffect(() => {
    onError(null);
    Promise.all([
      api.overview(days, profile),
      api.drivers("model", days, profile),
      api.drivers("tool", days, profile),
    ])
      .then(([o, m, t]) => {
        setStats(o);
        setByModel(m.slice(0, 8));
        setByTool(t.slice(0, 8));
      })
      .catch((e) => onError(String(e)));
  }, [days, profile, onError]);

  if (!stats) return <p className="text-muted-foreground p-4">Loading...</p>;

  return (
    <div className="animate-fade-in space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="Sessions" value={fmtNum(stats.sessions)} />
        <Stat label="Turns" value={fmtNum(stats.num_turns)} />
        <Stat label="Tool calls" value={fmtNum(stats.tool_calls)} />
        <Stat label="File reads" value={fmtNum(stats.file_reads)} />
        <Stat label="Total tokens" value={fmtNum(stats.total_tokens)} />
        <Stat label="Input tokens" value={fmtNum(stats.input_tokens)} />
        <Stat label="Output tokens" value={fmtNum(stats.output_tokens)} />
        <Stat label="Cache read tok" value={fmtNum(stats.cache_reads ?? 0)} />
        <Stat label="Cache write tok" value={fmtNum(stats.cache_writes ?? 0)} />
        <Stat label="Est. cost" value={fmtCost(stats.total_cost_usd)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="rounded-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Cost by model</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              rows={byModel.map((r) => ({
                label: r.key,
                value: r.total_cost_usd,
                display: fmtCost(r.total_cost_usd),
              }))}
            />
          </CardContent>
        </Card>

        <Card className="rounded-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Top tools by call volume</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              rows={byTool.map((r) => ({
                label: r.key,
                value: r.tool_calls,
                display: fmtNum(r.tool_calls),
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
