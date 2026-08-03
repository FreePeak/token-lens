import { useEffect, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
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

type ProfileFilter = string | undefined;
type DaysFilter = number | undefined;

function useFilters(): {
  days: DaysFilter;
  profile: ProfileFilter;
  setDays: (v: DaysFilter) => void;
  setProfile: (v: ProfileFilter) => void;
} {
  const [params, setParams] = useSearchParams();
  const daysRaw = params.get("days");
  const days: DaysFilter =
    daysRaw === null ? 30 : daysRaw === "all" ? undefined : Number(daysRaw);
  const profile: ProfileFilter = params.get("profile") ?? undefined;

  function setDays(v: DaysFilter) {
    const next = new URLSearchParams(params);
    if (v === undefined) next.set("days", "all");
    else next.set("days", String(v));
    setParams(next, { replace: true });
  }

  function setProfile(v: ProfileFilter) {
    const next = new URLSearchParams(params);
    if (v === undefined) next.delete("profile");
    else next.set("profile", v);
    setParams(next, { replace: true });
  }

  return { days, profile, setDays, setProfile };
}

function Header({ active }: { active: "overview" | "sessions" | "drivers" }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 mb-6 pb-4 border-b border-border">
      <h1 className="text-xl font-semibold tracking-tight">Token Lens</h1>
      <nav className="flex gap-1">
        <Button
          asChild
          variant={active === "overview" ? "default" : "ghost"}
          size="sm"
        >
          <Link to="/">Overview</Link>
        </Button>
        <Button
          asChild
          variant={active === "sessions" ? "default" : "ghost"}
          size="sm"
        >
          <Link to="/sessions">Sessions</Link>
        </Button>
        <Button
          asChild
          variant={active === "drivers" ? "default" : "ghost"}
          size="sm"
        >
          <Link to="/drivers">Drivers</Link>
        </Button>
      </nav>
    </header>
  );
}

function Filters({
  days,
  profile,
  profiles,
  setDays,
  setProfile,
}: {
  days: DaysFilter;
  profile: ProfileFilter;
  profiles: string[];
  setDays: (v: DaysFilter) => void;
  setProfile: (v: ProfileFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-6 text-sm">
      <Select
        value={days === undefined ? "all" : days.toString()}
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
  );
}

function Shell({
  active,
  days,
  profile,
  setDays,
  setProfile,
  profiles,
  error,
  setError,
  children,
}: {
  active: "overview" | "sessions" | "drivers";
  days: DaysFilter;
  profile: ProfileFilter;
  setDays: (v: DaysFilter) => void;
  setProfile: (v: ProfileFilter) => void;
  profiles: string[];
  error: string | null;
  setError: (v: string | null) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        <Header active={active} />
        <Filters
          days={days}
          profile={profile}
          profiles={profiles}
          setDays={setDays}
          setProfile={setProfile}
        />
        {error && (
          <div className="mb-4 p-3 border border-destructive/50 bg-destructive/10 text-destructive text-sm rounded-md">
            {error}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function OverviewPage() {
  const { days, profile, setDays, setProfile } = useFilters();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.profiles().then(setProfiles).catch((e) => setError(String(e)));
  }, []);
  return (
    <Shell
      active="overview"
      days={days}
      profile={profile}
      setDays={setDays}
      setProfile={setProfile}
      profiles={profiles}
      error={error}
      setError={setError}
    >
      <Overview days={days} profile={profile} onError={setError} />
    </Shell>
  );
}

function SessionsPage() {
  const { days, profile, setDays, setProfile } = useFilters();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.profiles().then(setProfiles).catch((e) => setError(String(e)));
  }, []);
  return (
    <Shell
      active="sessions"
      days={days}
      profile={profile}
      setDays={setDays}
      setProfile={setProfile}
      profiles={profiles}
      error={error}
      setError={setError}
    >
      <Sessions
        days={days}
        profile={profile}
        onError={setError}
        onOpen={(id) => navigate(`/sessions/${id}`)}
      />
    </Shell>
  );
}

function DriversPage() {
  const { days, profile, setDays, setProfile } = useFilters();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.profiles().then(setProfiles).catch((e) => setError(String(e)));
  }, []);
  return (
    <Shell
      active="drivers"
      days={days}
      profile={profile}
      setDays={setDays}
      setProfile={setProfile}
      profiles={profiles}
      error={error}
      setError={setError}
    >
      <Drivers days={days} profile={profile} onError={setError} />
    </Shell>
  );
}

function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const { days, profile, setDays, setProfile } = useFilters();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.profiles().then(setProfiles).catch((e) => setError(String(e)));
  }, []);
  if (!id) return null;
  return (
    <Shell
      active="sessions"
      days={days}
      profile={profile}
      setDays={setDays}
      setProfile={setProfile}
      profiles={profiles}
      error={error}
      setError={setError}
    >
      <Detail
        id={id}
        onError={setError}
        onBack={() => navigate("/sessions")}
      />
    </Shell>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<OverviewPage />} />
      <Route path="/sessions" element={<SessionsPage />} />
      <Route path="/sessions/:id" element={<DetailPage />} />
      <Route path="/drivers" element={<DriversPage />} />
    </Routes>
  );
}