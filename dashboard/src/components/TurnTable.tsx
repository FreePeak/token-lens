import { useMemo } from "react";
import { fmtCost, fmtNum, fmtDate, type SessionDetail } from "../api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Pretty label for a root-cause category badge. */
const ROOT_CAUSE_LABELS: Record<string, string> = {
  context_accumulation: "context growth",
  tool_output_amplification: "tool output",
  search_thrashing: "search thrashing",
  retry_amplification: "retries",
  duplicate_generation: "duplicate",
  model_selection: "model pick",
  cache_failure: "cache miss",
  reasoning_surprise: "reasoning",
  pricing_uncertainty: "pricing",
  data_quality: "data quality",
};

export function TurnTable({ detail }: { detail: SessionDetail }) {
  const causeByGen = useMemo(() => {
    const m = new Map<string, { category: string; confidence: number }>();
    for (const ev of detail.root_causes ?? []) {
      if (!ev.generation_id) continue;
      const cur = m.get(ev.generation_id);
      if (!cur || ev.confidence > cur.confidence) {
        m.set(ev.generation_id, { category: ev.category, confidence: ev.confidence });
      }
    }
    return m;
  }, [detail.root_causes]);

  if (!detail.turns.length) {
    return (
      <Card className="rounded-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Turns</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No turn cost data yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Turns ({detail.turns.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Gen</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right font-mono">Input</TableHead>
              <TableHead className="text-right font-mono">Output</TableHead>
              <TableHead className="text-right font-mono">Cache read</TableHead>
              <TableHead className="text-right font-mono">Cost</TableHead>
              <TableHead>Cause</TableHead>
              <TableHead className="text-right font-mono">Ended</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.turns.map((t) => {
              const est = !!t.estimated;
              const inT = t.input_tokens ?? 0;
              const outT = t.output_tokens ?? 0;
              const crT = t.cache_read_tokens ?? 0;
              const cost = t.total_cost_usd ?? 0;
              const cause = causeByGen.get(t.generation_id);
              return (
                <TableRow key={t.generation_id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {t.generation_id.slice(0, 12)}…
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.model ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {est ? "~" : ""}{fmtNum(inT)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {est ? "~" : ""}{fmtNum(outT)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtNum(crT)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {est ? "~" : ""}{fmtCost(cost)}
                  </TableCell>
                  <TableCell>
                    {cause ? (
                      <Badge variant="outline" className="text-[10px]">
                        {ROOT_CAUSE_LABELS[cause.category] ?? cause.category}
                        {" "}
                        <span className="text-muted-foreground">
                          {(cause.confidence * 100).toFixed(0)}%
                        </span>
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {t.ended_at ? fmtDate(t.ended_at) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
