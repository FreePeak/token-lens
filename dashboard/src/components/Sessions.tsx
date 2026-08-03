import { useEffect, useMemo, useState } from "react";
import { api, fmtCost, fmtDate, fmtDuration, fmtNum, shortTitle, type SessionRollup, type SessionSort } from "../api";
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
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

export function Sessions({
  days,
  profile,
  onError,
  onOpen,
}: {
  days?: number;
  profile?: string;
  onError: (e: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<SessionRollup[]>([]);
  const [leankgOnly, setLeankgOnly] = useState<"all" | "yes" | "no">("all");
  const [sortBy, setSortBy] = useState<SessionSort>("date");

  useEffect(() => {
    onError(null);
    api
      .sessions(days, profile, sortBy)
      .then(setRows)
      .catch((e) => onError(String(e)));
  }, [days, profile, sortBy, onError]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (leankgOnly === "yes") return !!r.used_leankg;
      if (leankgOnly === "no") return !r.used_leankg;
      return true;
    });
  }, [rows, leankgOnly]);

  const sortLabel =
    sortBy === "date" ? "date (newest first)" : sortBy === "cost" ? "est. cost" : "duration";

  function SortHead({ id, label }: { id: SessionSort; label: string }) {
    return (
      <TableHead
        className={cn("cursor-pointer select-none hover:text-foreground transition-colors", sortBy === id && "text-primary")}
        onClick={() => setSortBy(id)}
      >
        {label}
        {sortBy === id ? " ↓" : ""}
      </TableHead>
    );
  }

  return (
    <Card className="rounded-none">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-base font-semibold">
            Sessions ({filtered.length})
          </CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground ml-auto">
            <span>Sort</span>
            {(["date", "cost", "duration"] as const).map((v) => (
              <Badge
                key={v}
                variant={sortBy === v ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setSortBy(v)}
              >
                {v}
              </Badge>
            ))}
          </div>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>LeanKG</span>
            {(["all", "yes", "no"] as const).map((v) => (
              <Badge
                key={v}
                variant={leankgOnly === v ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setLeankgOnly(v)}
              >
                {v}
              </Badge>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Sorted by {sortLabel}. Click column headers to sort. "~" = tokens estimated.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <SortHead id="date" label="Date" />
                <TableHead>Model</TableHead>
                <TableHead>LeanKG</TableHead>
                <TableHead className="text-right font-mono">Turns</TableHead>
                <TableHead className="text-right font-mono">Tools</TableHead>
                <TableHead className="text-right font-mono">Search</TableHead>
                <TableHead className="text-right font-mono">Reads</TableHead>
                <TableHead className="text-right font-mono">In</TableHead>
                <TableHead className="text-right font-mono">Out</TableHead>
                <SortHead id="cost" label="Cost" />
                <SortHead id="duration" label="Duration" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow
                  key={r.conversation_id}
                  className="cursor-pointer hover:bg-secondary/50"
                  onClick={() => onOpen(r.conversation_id)}
                >
                  <TableCell className="max-w-48 truncate font-medium">
                    {shortTitle(r)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{fmtDate(r.started_at)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{r.model ?? "—"}</TableCell>
                  <TableCell>
                    {r.used_leankg ? (
                      <Badge variant="outline" className="text-[10px]">
                        yes ({fmtNum(r.leankg_calls ?? 0)})
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">no</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.num_turns)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.tool_calls)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.search_calls ?? 0)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.file_reads)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.tokens_estimated ? "~" : ""}
                    {fmtNum(r.input_tokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.tokens_estimated ? "~" : ""}
                    {fmtNum(r.output_tokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.tokens_estimated ? "~" : ""}
                    {fmtCost(r.total_cost_usd)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtDuration(r.duration_ms)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!filtered.length && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No sessions yet. Run <code className="bg-secondary px-1 rounded text-xs">bun run backfill</code>.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
