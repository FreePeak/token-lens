import { type SessionRollup } from "../api";
import { Card, CardContent } from "@/components/ui/card";

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="rounded-none">
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5">
          {label}
        </p>
        <p className="text-lg font-mono tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
