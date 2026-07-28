import { useEffect, useMemo, useState } from "react";
import {
  api,
  fmtCost,
  fmtDate,
  fmtDuration,
  fmtNum,
  shortTitle,
  shortWs,
  type DriverRow,
  type OverviewStats,
  type SessionDetail,
  type SessionRollup,
  type SessionSort,
} from "./api";

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
    <div className="layout">
      <header>
        <h1>Cursor Metrics</h1>
        <nav>
          {(
            [
              ["overview", "Overview"],
              ["sessions", "Sessions"],
              ["drivers", "Drivers"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={page === id || (page === "detail" && id === "sessions") ? "active" : ""}
              onClick={() => {
                setPage(id);
                setSessionId(null);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="controls">
        <label>
          Range{" "}
          <select
            value={days ?? "all"}
            onChange={(e) => {
              const v = e.target.value;
              setDays(v === "all" ? undefined : Number(v));
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <span>Profile</span>
        <button className={!profile ? "active" : ""} onClick={() => setProfile(undefined)}>
          all
        </button>
        {profiles.map((p) => (
          <button key={p} className={profile === p ? "active" : ""} onClick={() => setProfile(p)}>
            {p}
          </button>
        ))}
        <span className="muted">Local only · costs are estimates from prices.json</span>
      </div>

      {error && <div className="error">{error}</div>}

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
  );
}

function Overview({
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

  if (!stats) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="cards">
        <Stat label="Sessions" value={fmtNum(stats.sessions)} />
        <Stat label="Turns" value={fmtNum(stats.num_turns)} />
        <Stat label="Tool calls" value={fmtNum(stats.tool_calls)} />
        <Stat label="File reads" value={fmtNum(stats.file_reads)} />
        <Stat label="Cache read tok" value={fmtNum(stats.cache_reads ?? 0)} />
        <Stat label="Cache write tok" value={fmtNum(stats.cache_writes ?? 0)} />
        <Stat label="Input tok" value={fmtNum(stats.input_tokens)} />
        <Stat label="Output tok" value={fmtNum(stats.output_tokens)} />
        <Stat label="Total tok" value={fmtNum(stats.total_tokens)} />
        <Stat label="Est. cost" value={fmtCost(stats.total_cost_usd)} />
      </div>
      <div className="two-col">
        <div className="panel">
          <h2>Cost by model</h2>
          <BarList
            rows={byModel.map((r) => ({
              label: r.key,
              value: r.total_cost_usd,
              display: fmtCost(r.total_cost_usd),
            }))}
          />
        </div>
        <div className="panel">
          <h2>Top tools by call volume</h2>
          <BarList
            rows={byTool.map((r) => ({
              label: r.key,
              value: r.tool_calls,
              display: fmtNum(r.tool_calls),
            }))}
          />
        </div>
      </div>
    </>
  );
}

function Sessions({
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

  function SortTh({
    id,
    label,
    num,
  }: {
    id: SessionSort;
    label: string;
    num?: boolean;
  }) {
    return (
      <th
        className={`sortable${num ? " num" : ""}${sortBy === id ? " sorted" : ""}`}
        onClick={() => setSortBy(id)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {sortBy === id ? " ↓" : ""}
      </th>
    );
  }

  return (
    <div className="panel" style={{ overflowX: "auto" }}>
      <div className="controls" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Sessions ({filtered.length})</h2>
        <span>Sort</span>
        {(["date", "cost", "duration"] as const).map((v) => (
          <button key={v} className={sortBy === v ? "active" : ""} onClick={() => setSortBy(v)}>
            {v}
          </button>
        ))}
        <span>LeanKG</span>
        {(["all", "yes", "no"] as const).map((v) => (
          <button key={v} className={leankgOnly === v ? "active" : ""} onClick={() => setLeankgOnly(v)}>
            {v}
          </button>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Sorted by {sortLabel}. Click Date / Cost / Duration headers. "~" = tokens estimated. Waste signal: high Search vs LeanKG.
      </p>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <SortTh id="date" label="Date" />
            <th>Model</th>
            <th>LeanKG</th>
            <th className="num">Turns</th>
            <th className="num">Tools</th>
            <th className="num">Search</th>
            <th className="num">Reads</th>
            <th className="num">Cache R tok</th>
            <th className="num">Cache W tok</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <SortTh id="cost" label="Cost" num />
            <SortTh id="duration" label="Duration" num />
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.conversation_id} className="clickable" onClick={() => onOpen(r.conversation_id)}>
              <td>{shortTitle(r)}</td>
              <td className="muted">{fmtDate(r.started_at)}</td>
              <td className="muted">{r.model ?? "—"}</td>
              <td>
                {r.used_leankg
                  ? `yes (${fmtNum(r.leankg_calls ?? 0)})`
                  : "no"}
              </td>
              <td className="num">{fmtNum(r.num_turns)}</td>
              <td className="num">{fmtNum(r.tool_calls)}</td>
              <td className="num">{fmtNum(r.search_calls ?? 0)}</td>
              <td className="num">{fmtNum(r.file_reads)}</td>
              <td className="num">{fmtNum(r.cache_reads ?? 0)}</td>
              <td className="num">{fmtNum(r.cache_writes ?? 0)}</td>
              <td className="num">
                {r.tokens_estimated ? "~" : ""}
                {fmtNum(r.input_tokens)}
              </td>
              <td className="num">
                {r.tokens_estimated ? "~" : ""}
                {fmtNum(r.output_tokens)}
              </td>
              <td className="num">
                {r.tokens_estimated ? "~" : ""}
                {fmtCost(r.total_cost_usd)}
              </td>
              <td className="num">{fmtDuration(r.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!filtered.length && <p className="muted">No sessions yet. Run `bun run backfill`.</p>}
    </div>
  );
}

function Drivers({
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
    <div className="panel">
      <div className="controls" style={{ marginBottom: "1rem" }}>
        <span>Group by</span>
        {(["model", "tool", "workspace"] as const).map((d) => (
          <button key={d} className={by === d ? "active" : ""} onClick={() => setBy(d)}>
            {d}
          </button>
        ))}
      </div>
      <h2>Cost drivers</h2>
      <table>
        <thead>
          <tr>
            <th>{by}</th>
            <th className="num">Sessions</th>
            <th className="num">Tools</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td className="num">{fmtNum(r.sessions)}</td>
              <td className="num">{fmtNum(r.tool_calls)}</td>
              <td className="num">{fmtNum(r.total_tokens)}</td>
              <td className="num">{fmtCost(r.total_cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({
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
    // one bar per user turn: user bubble (has prompt) opens a group; following
    // assistant/tool bubbles accumulate until the next user prompt
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

  if (!d) return <p className="muted">Loading…</p>;

  return (
    <>
      <a className="back" href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>
        ← Sessions
      </a>
      <div className="cards">
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
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <h2>First user prompt</h2>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {d.first_prompt?.trim() || <span className="muted">No user text captured</span>}
        </p>
        <div className="controls" style={{ marginTop: "0.75rem", gap: "1rem", flexWrap: "wrap" }}>
          <span>
            Search / LeanKG:{" "}
            <strong>
              {fmtNum(d.search_calls ?? 0)} / {fmtNum(d.leankg_calls ?? 0)}
            </strong>
            {(d.leankg_calls ?? 0) === 0 && (d.search_calls ?? 0) > 20 ? (
              <span className="muted"> · high search without LeanKG</span>
            ) : null}
          </span>
          <span>
            Tokens / turn:{" "}
            <strong>
              {d.num_turns
                ? `${d.tokens_estimated ? "~" : ""}${fmtNum(Math.round(d.total_tokens / d.num_turns))}`
                : "—"}
            </strong>
          </span>
          <span>
            Tools / turn:{" "}
            <strong>
              {d.num_turns ? (d.tool_calls / d.num_turns).toFixed(1) : "—"}
            </strong>
          </span>
        </div>
      </div>
      <div className="two-col">
        <div className="panel">
          <h2>Named tools (call volume)</h2>
          <BarList
            rows={d.tools.map((t) => ({
              label: t.tool_name,
              value: t.count,
              display: `${t.count}${t.failures ? ` (${t.failures} fail)` : ""}`,
            }))}
          />
          {!d.tools.length && <p className="muted">No tool events yet (hooks or backfill).</p>}
        </div>
        <div className="panel">
          <h2>Tokens by turn</h2>
          <BarList rows={tokenSeries} />
          {!tokenSeries.length && <p className="muted">No token bubbles yet — re-run backfill.</p>}
        </div>
      </div>
      <div className="panel">
        <h2>Turns ({d.turns.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Generation</th>
              <th>Status</th>
              <th className="num">Ended</th>
            </tr>
          </thead>
          <tbody>
            {d.turns.map((t) => (
              <tr key={t.generation_id}>
                <td className="muted">{t.generation_id.slice(0, 12)}…</td>
                <td>{t.status ?? "—"}</td>
                <td className="num">
                  {t.ended_at ? new Date(t.ended_at).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function BarList({
  rows,
}: {
  rows: Array<{ label: string; value: number; display: string }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r, i) => (
        <div className="bar-row" key={`${i}-${r.label}`}>
          <span title={r.label}>{r.label.length > 48 ? `${r.label.slice(0, 46)}…` : r.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="num muted">{r.display}</span>
        </div>
      ))}
      {!rows.length && <p className="muted">No data</p>}
    </div>
  );
}
