import { useEffect, useMemo, useState } from "react";
import { api, fmtCost, fmtDate, fmtNum, shortTitle, type SessionDetail } from "../api";
import { Stat } from "./Stat";
import { BarList } from "./BarList";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft } from "lucide-react";

export function Detail({
  id,
  onError,
  onBack,
}: {
  id: string;
  onError: (e: string | null) => void;
  onBack: () => void;
}) {
  const [d, setD] = useState<SessionDetail | null>(null);

  useEffect(() => {
    onError(null);
    api
      .session(id)
      .then(setD)
      .catch((e) => onError(String(e)));
  }, [id, onError]);

  const tokenSeries = useMemo(() => {
    if (!d) return [];
    const groups: Array<{ label: string; value: number }> = [];
    let cur: { label: string; value: number } | null = null;
    let turn = 0;
    for (const s of d.token_snapshots) {
      const p = s.prompt?.trim();
      if (p) {
        turn += 1;
        cur = { label: `#${turn} ${p.slice(0, 80)}`, value: 0 };
        groups.push(cur);
      } else if (!cur) {
        turn += 1;
        cur = { label: `#${turn}`, value: 0 };
        groups.push(cur);
      }
      cur.value += s.input_tokens + s.output_tokens;
    }
    return groups.map((g) => ({
      label: g.label,
      value: g.value,
      display: fmtNum(g.value),
    }));
  }, [d]);

  if (!d) return <p className="text-muted-foreground p-4">Loading...</p>;

  return (
    <div className="animate-fade-in space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
        <ArrowLeft className="h-4 w-4 mr-1" />
        Sessions
      </Button>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="Session" value={shortTitle(d)} />
        <Stat label="Model" value={d.model ?? "—"} />
        <Stat
          label="LeanKG"
          value={d.used_leankg ? `yes (${fmtNum(d.leankg_calls ?? 0)})` : "no"}
        />
        <Stat label="Turns" value={fmtNum(d.num_turns)} />
        <Stat label="Tools" value={fmtNum(d.tool_calls)} />
        <Stat label="Search / Reads" value={`${fmtNum(d.search_calls ?? 0)} / ${fmtNum(d.file_reads)}`} />
        <Stat label="Cache read tok" value={fmtNum(d.cache_reads ?? 0)} />
        <Stat label="Cache write tok" value={fmtNum(d.cache_writes ?? 0)} />
        <Stat
          label="In / Out"
          value={`${d.tokens_estimated ? "~" : ""}${fmtNum(d.input_tokens)} / ${d.tokens_estimated ? "~" : ""}${fmtNum(d.output_tokens)}`}
        />
        <Stat
          label="Est. cost"
          value={`${d.tokens_estimated ? "~" : ""}${fmtCost(d.total_cost_usd)}`}
        />
      </div>

      <Card className="rounded-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">First user prompt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {d.first_prompt?.trim() || "No user text captured"}
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>
              Search / LeanKG:{" "}
              <span className="font-mono font-semibold">
                {fmtNum(d.search_calls ?? 0)} / {fmtNum(d.leankg_calls ?? 0)}
              </span>
              {(d.leankg_calls ?? 0) === 0 && (d.search_calls ?? 0) > 20 && (
                <Badge variant="outline" className="ml-2 text-[10px] text-destructive border-destructive/50">
                  high search without LeanKG
                </Badge>
              )}
            </span>
            <span>
              Tokens / turn:{" "}
              <span className="font-mono font-semibold">
                {d.num_turns
                  ? `${d.tokens_estimated ? "~" : ""}${fmtNum(Math.round(d.total_tokens / d.num_turns))}`
                  : "—"}
              </span>
            </span>
            <span>
              Tools / turn:{" "}
              <span className="font-mono font-semibold">
                {d.num_turns ? (d.tool_calls / d.num_turns).toFixed(1) : "—"}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="rounded-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Named tools (call volume)</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList
              rows={d.tools.map((t) => ({
                label: t.tool_name,
                value: t.count,
                display: `${t.count}${t.failures ? ` (${t.failures} fail)` : ""}`,
              }))}
            />
            {!d.tools.length && <p className="text-sm text-muted-foreground">No tool events.</p>}
          </CardContent>
        </Card>

        <Card className="rounded-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Tokens by turn</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={tokenSeries} />
            {!tokenSeries.length && <p className="text-sm text-muted-foreground">No token data.</p>}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Turns ({d.turns.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Generation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right font-mono">Ended</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.turns.map((t) => (
                <TableRow key={t.generation_id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {t.generation_id.slice(0, 12)}...
                  </TableCell>
                  <TableCell>{t.status ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {t.ended_at ? fmtDate(t.ended_at) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
