import { useEffect, useState } from "react";
import { Overview } from "./components/Overview";
import { Sessions } from "./components/Sessions";
import { Drivers } from "./components/Drivers";
import { Detail } from "./components/Detail";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { api } from "./api";

type Page = "overview" | "sessions" | "drivers" | "detail";

export function App() {
  const [page, setPage] = useState<Page>("overview");
  const [days, setDays] = useState<number | undefined>(30);
  const [profile, setProfile] = useState<string | undefined>();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profiles().then(setProfiles).catch((e) => setError(String(e)));
  }, []);

  function openSession(id: string) {
    setSessionId(id);
    setPage("detail");
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 mb-6 pb-4 border-b border-border">
          <h1 className="text-xl font-semibold tracking-tight">Token Lens</h1>
          <nav className="flex gap-1">
            {(
              [
                ["overview", "Overview"],
                ["sessions", "Sessions"],
                ["drivers", "Drivers"],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                variant={page === id || (page === "detail" && id === "sessions") ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setPage(id);
                  setSessionId(null);
                }}
              >
                {label}
              </Button>
            ))}
          </nav>
        </header>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-6 text-sm">
          <Select
            value={days?.toString() ?? "all"}
            onValueChange={(v) => setDays(v === "all" ? undefined : Number(v))}
          >
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>

          <span className="text-muted-foreground">Profile</span>
          <Badge
            variant={!profile ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setProfile(undefined)}
          >
            all
          </Badge>
          {profiles.map((p) => (
            <Badge
              key={p}
              variant={profile === p ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setProfile(p)}
            >
              {p}
            </Badge>
          ))}
          <span className="text-muted-foreground text-xs ml-auto">
            Local only · costs are estimates from prices.json
          </span>
        </div>

        {error && (
          <div className="mb-4 p-3 border border-destructive/50 bg-destructive/10 text-destructive text-sm rounded-md">
            {error}
          </div>
        )}

        {/* Pages */}
        {page === "overview" && <Overview days={days} profile={profile} onError={setError} />}
        {page === "sessions" && (
          <Sessions days={days} profile={profile} onError={setError} onOpen={openSession} />
        )}
        {page === "drivers" && <Drivers days={days} profile={profile} onError={setError} />}
        {page === "detail" && sessionId && (
          <Detail
            id={sessionId}
            onError={setError}
            onBack={() => {
              setPage("sessions");
              setSessionId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
