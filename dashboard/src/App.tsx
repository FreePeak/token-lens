import { useEffect, useMemo, useState } from "react";
import {
  api,
  fmtCost,
  fmtDuration,
  fmtNum,
  shortTitle,
  shortWs,
  type DriverRow,
  type OverviewStats,
  type SessionDetail,
  type SessionRollup,
} from "./api";

type Page = "overview" | "sessions" | "drivers" | "detail";

export function App() {
  const [page, setPage] = useState<Page>("overview");
  const [days, setDays] = useState<number | undefined>(30);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <span className="muted">Local only · costs are estimates from prices.json</span>
      </div>

      {error && <div className="error">{error}</div>}

      {page === "overview" && <Overview days={days} onError={setError} />}
      {page === "sessions" && (
        <Sessions days={days} onError={setError} onOpen={openSession} />
      )}
      {page === "drivers" && <Drivers days={days} onError={setError} />}
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
  onError,
}: {
  days?: number;
  onError: (e: string | null) => void;
}) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [byModel, setByModel] = useState<DriverRow[]>([]);
  const [byTool, setByTool] = useState<DriverRow[]>([]);

  useEffect(() => {
    onError(null);
    Promise.all([
      api.overview(days),
      api.drivers("model", days),
      api.drivers("tool", days),
    ])
      .then(([o, m, t]) => {
        setStats(o);
        setByModel(m.slice(0, 8));
        setByTool(t.slice(0, 8));
      })
      .catch((e) => onError(String(e)));
  }, [days, onError]);

  if (!stats) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="cards">
        <Stat label="Sessions" value={fmtNum(stats.sessions)} />
        <Stat label="Turns" value={fmtNum(stats.num_turns)} />
        <Stat label="Tool calls" value={fmtNum(stats.tool_calls)} />
        <Stat label="File reads" value={fmtNum(stats.file_reads)} />
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
          <h2>Tool calls by name</h2>
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
  onError,
  onOpen,
}: {
  days?: number;
  onError: (e: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<SessionRollup[]>([]);
  const [leankgOnly, setLeankgOnly] = useState<"all" | "yes" | "no">("all");

  useEffect(() => {
    onError(null);
    api
      .sessions(days)
      .then(setRows)
      .catch((e) => onError(String(e)));
  }, [days, onError]);

  const filtered = rows.filter((r) => {
    if (leankgOnly === "yes") return !!r.used_leankg;
    if (leankgOnly === "no") return !r.used_leankg;
    return true;
  });

  return (
    <div className="panel" style={{ overflowX: "auto" }}>
      <div className="controls" style={{ marginBottom: "0.75rem" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Sessions ({filtered.length})</h2>
        <span>LeanKG</span>
        {(["all", "yes", "no"] as const).map((v) => (
          <button key={v} className={leankgOnly === v ? "active" : ""} onClick={() => setLeankgOnly(v)}>
            {v}
          </button>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Sorted by est. cost. "~" = tokens estimated (Cursor left tokenCount at 0). Waste signal: high Search vs LeanKG.
      </p>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Model</th>
            <th>LeanKG</th>
            <th className="num">Turns</th>
            <th className="num">Tools</th>
            <th className="num">Search</th>
            <th className="num">Reads</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <th className="num">Cost</th>
            <th className="num">Duration</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.conversation_id} className="clickable" onClick={() => onOpen(r.conversation_id)}>
              <td>{shortTitle(r)}</td>
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

function Drivers({ days, onError }: { days?: number; onError: (e: string | null) => void }) {
  const [by, setBy] = useState<"tool" | "model" | "workspace">("model");
  const [rows, setRows] = useState<DriverRow[]>([]);

  useEffect(() => {
    onError(null);
    api
      .drivers(by, days)
      .then(setRows)
      .catch((e) => onError(String(e)));
  }, [by, days, onError]);

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
    return d.token_snapshots.map((s, i) => ({
      label: `#${i + 1}`,
      value: s.input_tokens + s.output_tokens,
      display: fmtNum(s.input_tokens + s.output_tokens),
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
        <Stat
          label="In / Out"
          value={`${d.tokens_estimated ? "~" : ""}${fmtNum(d.input_tokens)} / ${d.tokens_estimated ? "~" : ""}${fmtNum(d.output_tokens)}`}
        />
        <Stat
          label="Est. cost"
          value={`${d.tokens_estimated ? "~" : ""}${fmtCost(d.total_cost_usd)}`}
        />
      </div>
      <div className="two-col">
        <div className="panel">
          <h2>Tools (cost drivers)</h2>
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
          <h2>Token snapshots</h2>
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
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span title={r.label}>{r.label.length > 22 ? `${r.label.slice(0, 20)}…` : r.label}</span>
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
