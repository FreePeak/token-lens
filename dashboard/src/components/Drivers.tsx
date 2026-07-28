import { useEffect, useState } from "react";
import { api, fmtCost, fmtNum, type DriverRow } from "../api";
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

export function Drivers({
  days,
  profile,
  onError,
}: {
  days?: number;
  profile?: string;
  onError: (e: string | null) => void;
}) {
  const [by, setBy] = useState<"tool" | "model" | "workspace">("tool");
  const [rows, setRows] = useState<DriverRow[]>([]);

  useEffect(() => {
    onError(null);
    api
      .drivers(by, days, profile)
      .then(setRows)
      .catch((e) => onError(String(e)));
  }, [by, days, profile, onError]);

  return (
    <Card className="rounded-none">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-base font-semibold">Cost drivers</CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground ml-auto">
            <span>Group by</span>
            {(["model", "tool", "workspace"] as const).map((d) => (
              <Badge
                key={d}
                variant={by === d ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setBy(d)}
              >
                {d}
              </Badge>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{by}</TableHead>
              <TableHead className="text-right font-mono">Sessions</TableHead>
              <TableHead className="text-right font-mono">Tools</TableHead>
              <TableHead className="text-right font-mono">Tokens</TableHead>
              <TableHead className="text-right font-mono">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{r.key}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.sessions)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.tool_calls)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.total_tokens)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{fmtCost(r.total_cost_usd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!rows.length && (
          <p className="text-sm text-muted-foreground py-8 text-center">No data.</p>
        )}
      </CardContent>
    </Card>
  );
}
