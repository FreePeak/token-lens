#!/usr/bin/env bun
import { openMetricsDb, METRICS_DB_PATH } from "./db/schema";
import type { Database } from "bun:sqlite";

// --- helpers ---

function q<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function q1<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql).get(...params) as T) ?? null;
}

const N = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const USD = (n: number): string => `$${n.toFixed(2)}`;
const D = (n: number): string => new Date(n).toISOString().replace("T", " ").slice(0, 19);
const P = (a: number, b: number): string => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

const H1 = (s: string) => `\n# ${s}\n`;
const H2 = (s: string) => `\n## ${s}\n`;
const H3 = (s: string) => `\n### ${s}\n`;

function table(headers: string[], rows: string[][]): string {
  const lens = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = "|" + lens.map((l) => "-".repeat(l + 2)).join("|") + "|";
  const hdr =
    "| " + headers.map((h, i) => h.padEnd(lens[i])).join(" | ") + " |";
  const body = rows
    .map(
      (r) =>
        "| " +
        r.map((c, i) => (c ?? "").padEnd(lens[i])).join(" | ") +
        " |",
    )
    .join("\n");
  return `${hdr}\n${sep}\n${body}`;
}

function where(opts: {
  sinceMs: number;
  profile: string | null;
}): { clause: string; params: unknown[] } {
  const clauses: string[] = ["r.started_at >= ?"];
  const params: unknown[] = [opts.sinceMs];
  if (opts.profile) {
    clauses.push("r.profile = ?");
    params.push(opts.profile);
  }
  return { clause: clauses.join(" AND "), params };
}

// --- main ---

async function main() {
  const args = process.argv.slice(2);

  const topN = (() => {
    const i = args.indexOf("--sessions");
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 10;
  })();

  const sinceDays = (() => {
    const i = args.indexOf("--since");
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 30;
  })();

  const profile =
    (() => {
      const i = args.indexOf("--profile");
      return i >= 0 ? (args[i + 1] ?? null) : null;
    })() ?? null;

  const useClaude = args.includes("--claude");
  const useHtml = args.includes("--html");
  const htmlPath = (() => {
    const i = args.indexOf("--html");
    if (i < 0) return null;
    const v = args[i + 1];
    return v && !v.startsWith("--") ? v : null;
  })();
  const detailN = 3;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const db = openMetricsDb();
  const w = where({ sinceMs, profile });

  let out = "";

  // --- Section 1: Overview ---
  out += H1("Cursor Token Waste Analysis");
  out += `Period: last ${sinceDays} days${profile ? ` | Profile: ${profile}` : ""} | Generated: ${new Date().toISOString().slice(0, 19)}\n`;
  out += `DB: \`${METRICS_DB_PATH}\`\n`;

  const overview = q1<{
    sessions: number;
    turns: number;
    tools: number;
    reads: number;
    input: number;
    output: number;
    cache_r: number;
    cache_w: number;
    cost: number;
  }>(
    db,
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(r.num_turns),0) AS turns,
            COALESCE(SUM(r.tool_calls),0) AS tools,
            COALESCE(SUM(r.file_reads),0) AS reads,
            COALESCE(SUM(r.input_tokens),0) AS input,
            COALESCE(SUM(r.output_tokens),0) AS output,
            COALESCE(SUM(r.cache_reads),0) AS cache_r,
            COALESCE(SUM(r.cache_writes),0) AS cache_w,
            COALESCE(SUM(r.total_cost_usd),0) AS cost
     FROM session_rollups r WHERE ${w.clause}`,
    ...w.params,
  );

  if (!overview || overview.sessions === 0) {
    out += "\n**No sessions found in the selected period.**\n";
    console.log(out);
    db.close();
    return;
  }

  const estSessions =
    q1<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM session_rollups r WHERE ${w.clause} AND r.tokens_estimated = 1`,
      ...w.params,
    )?.n ?? 0;

  const profiles = q<{ profile: string; n: number; cost: number }>(
    db,
    `SELECT COALESCE(r.profile,'(none)') AS profile, COUNT(*) AS n, COALESCE(SUM(r.total_cost_usd),0) AS cost
     FROM session_rollups r WHERE ${w.clause} GROUP BY r.profile ORDER BY cost DESC`,
    ...w.params,
  );

  out += table(
    ["Metric", "Value"],
    [
      ["Sessions", String(overview.sessions)],
      ["Turns", N(overview.turns)],
      ["Tool calls", N(overview.tools)],
      ["File reads", N(overview.reads)],
      ["Input tokens", N(overview.input)],
      ["Output tokens", N(overview.output)],
      ["Total tokens", N(overview.input + overview.output)],
      ["Cache read tokens", N(overview.cache_r)],
      ["Cache write tokens", N(overview.cache_w)],
      ["Cache hit rate", P(overview.cache_r, overview.input + overview.cache_r)],
      ["Estimated cost", USD(overview.cost)],
      [
        "Sessions w/ est. tokens",
        `${estSessions} (${P(estSessions, overview.sessions)})`,
      ],
    ],
  );

  if (profiles.length > 1) {
    out += H3("By Profile");
    out += table(
      ["Profile", "Sessions", "Cost"],
      profiles.map((p) => [p.profile, String(p.n), USD(p.cost)]),
    );
  }

  // --- Section 2: Top Sessions by Cost ---
  out += H2("Top Sessions by Cost");
  const topCost = q<{
    conversation_id: string;
    title: string;
    model: string;
    profile: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    total_cost_usd: number;
    num_turns: number;
    tool_calls: number;
    file_reads: number;
    started_at: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.model, r.profile,
            r.input_tokens, r.output_tokens, r.total_tokens, r.total_cost_usd,
            r.num_turns, r.tool_calls, r.file_reads, r.started_at
     FROM session_rollups r WHERE ${w.clause}
     ORDER BY r.total_cost_usd DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  out += table(
    [
      "Rank",
      "Session",
      "Title",
      "Model",
      "Profile",
      "Cost",
      "Input",
      "Output",
      "Turns",
      "Tools",
      "Reads",
      "Date",
    ],
    topCost.map((s, i) => [
      String(i + 1),
      s.conversation_id.slice(0, 10) + "…",
      (s.title ?? "—").slice(0, 45),
      s.model ?? "—",
      s.profile ?? "—",
      USD(s.total_cost_usd),
      N(s.input_tokens),
      N(s.output_tokens),
      String(s.num_turns),
      String(s.tool_calls),
      String(s.file_reads),
      s.started_at ? D(s.started_at).slice(0, 10) : "—",
    ]),
  );

  // --- Section 3: Context Bloat ---
  out += H2("Context Bloat: Top Sessions by Input Tokens");
  const topInput = q<{
    conversation_id: string;
    title: string;
    input_tokens: number;
    output_tokens: number;
    total_cost_usd: number;
    num_turns: number;
    cache_reads: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.input_tokens, r.output_tokens,
            r.total_cost_usd, r.num_turns, r.cache_reads
     FROM session_rollups r WHERE ${w.clause}
     ORDER BY r.input_tokens DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  out += table(
    [
      "Rank",
      "Session",
      "Title",
      "Input",
      "Output",
      "Turns",
      "Tokens/Turn",
      "Cache Hit",
      "Cost",
    ],
    topInput.map((s, i) => [
      String(i + 1),
      s.conversation_id.slice(0, 10) + "…",
      (s.title ?? "—").slice(0, 35),
      N(s.input_tokens),
      N(s.output_tokens),
      String(s.num_turns),
      N(Math.round(s.input_tokens / Math.max(1, s.num_turns))),
      P(s.cache_reads, s.input_tokens + s.cache_reads),
      USD(s.total_cost_usd),
    ]),
  );

  // --- Section 4: Cost-Per-Turn Efficiency ---
  out += H2("Cost Per Turn: Most Expensive Short Sessions");
  const costPerTurn = q<{
    conversation_id: string;
    title: string;
    total_cost_usd: number;
    num_turns: number;
    input_tokens: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.total_cost_usd, r.num_turns, r.input_tokens
     FROM session_rollups r WHERE ${w.clause} AND r.num_turns > 0
     ORDER BY r.total_cost_usd / r.num_turns DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  out += table(
    ["Rank", "Session", "Title", "Cost", "Turns", "Cost/Turn", "Input"],
    costPerTurn.map((s, i) => [
      String(i + 1),
      s.conversation_id.slice(0, 10) + "…",
      (s.title ?? "—").slice(0, 40),
      USD(s.total_cost_usd),
      String(s.num_turns),
      USD(s.total_cost_usd / s.num_turns),
      N(s.input_tokens),
    ]),
  );

  // --- Section 5: Cache Waste ---
  out += H2("Cache Waste: Low Cache Hit Rate");
  const lowCache = q<{
    conversation_id: string;
    title: string;
    input_tokens: number;
    cache_reads: number;
    cache_writes: number;
    total_cost_usd: number;
    num_turns: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.input_tokens, r.cache_reads, r.cache_writes,
            r.total_cost_usd, r.num_turns
     FROM session_rollups r WHERE ${w.clause} AND r.input_tokens > 10000
     ORDER BY CAST(r.cache_reads AS REAL) / NULLIF(r.input_tokens + r.cache_reads, 0) ASC LIMIT ?`,
    ...w.params,
    topN,
  );

  if (lowCache.length > 0) {
    out += table(
      [
        "Session",
        "Input",
        "Cache Read",
        "Cache Write",
        "Hit Rate",
        "Turns",
        "Cost",
      ],
      lowCache.map((s) => [
        s.conversation_id.slice(0, 10) + "…",
        N(s.input_tokens),
        N(s.cache_reads),
        N(s.cache_writes),
        P(s.cache_reads, s.input_tokens + s.cache_reads),
        String(s.num_turns),
        USD(s.total_cost_usd),
      ]),
    );
  } else {
    out += "_No sessions with significant cache inefficiency found._\n";
  }

  // --- Section 6: Search vs LeanKG ---
  out += H2("Graph Bypass: Search Instead of LeanKG");
  const bypassSearch = q<{
    conversation_id: string;
    title: string;
    search_calls: number;
    leankg_calls: number;
    file_reads: number;
    input_tokens: number;
    total_cost_usd: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.search_calls, r.leankg_calls,
            r.file_reads, r.input_tokens, r.total_cost_usd
     FROM session_rollups r WHERE ${w.clause} AND r.search_calls > 0 AND r.leankg_calls = 0
     ORDER BY r.search_calls DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  if (bypassSearch.length > 0) {
    out += `\n**${bypassSearch.length} sessions** used search tools but never LeanKG.\n\n`;
    out += table(
      ["Session", "Title", "Search", "LeanKG", "Reads", "Input", "Cost"],
      bypassSearch.map((s) => [
        s.conversation_id.slice(0, 10) + "…",
        (s.title ?? "—").slice(0, 35),
        String(s.search_calls),
        String(s.leankg_calls),
        String(s.file_reads),
        N(s.input_tokens),
        USD(s.total_cost_usd),
      ]),
    );
  } else {
    out += "_All sessions used LeanKG when searching._\n";
  }

  const searchHeavy = q<{
    conversation_id: string;
    title: string;
    search_calls: number;
    leankg_calls: number;
    total_cost_usd: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.search_calls, r.leankg_calls, r.total_cost_usd
     FROM session_rollups r WHERE ${w.clause} AND r.search_calls > r.leankg_calls * 2 AND r.search_calls > 5
     ORDER BY r.search_calls DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  if (searchHeavy.length > 0) {
    out += H3("Search-Heavy Sessions (search > 2x LeanKG)");
    out += table(
      ["Session", "Title", "Search", "LeanKG", "Ratio", "Cost"],
      searchHeavy.map((s) => [
        s.conversation_id.slice(0, 10) + "…",
        (s.title ?? "—").slice(0, 35),
        String(s.search_calls),
        String(s.leankg_calls),
        s.leankg_calls
          ? (s.search_calls / s.leankg_calls).toFixed(1) + "x"
          : "inf",
        USD(s.total_cost_usd),
      ]),
    );
  }

  // --- Section 7: Excessive File Reads ---
  out += H2("Excessive File Reads");
  const heavyRead = q<{
    conversation_id: string;
    title: string;
    file_reads: number;
    tool_calls: number;
    num_turns: number;
    input_tokens: number;
    total_cost_usd: number;
  }>(
    db,
    `SELECT r.conversation_id, r.title, r.file_reads, r.tool_calls, r.num_turns,
            r.input_tokens, r.total_cost_usd
     FROM session_rollups r WHERE ${w.clause} AND r.file_reads > 20
     ORDER BY CAST(r.file_reads AS REAL) / NULLIF(r.num_turns, 0) DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  if (heavyRead.length > 0) {
    out += table(
      [
        "Session",
        "Title",
        "Reads",
        "Tools",
        "Turns",
        "Reads/Turn",
        "Input",
        "Cost",
      ],
      heavyRead.map((s) => [
        s.conversation_id.slice(0, 10) + "…",
        (s.title ?? "—").slice(0, 30),
        String(s.file_reads),
        String(s.tool_calls),
        String(s.num_turns),
        (s.file_reads / Math.max(1, s.num_turns)).toFixed(1),
        N(s.input_tokens),
        USD(s.total_cost_usd),
      ]),
    );
  }

  // --- Section 8: Context Pressure ---
  out += H2("Context Pressure: Sessions Nearing Limit");
  const ctxPressure = q<{
    conversation_id: string;
    title: string;
    max_pct: number;
    avg_pct: number;
    events: number;
    input_tokens: number;
    total_cost_usd: number;
  }>(
    db,
    `SELECT e.conversation_id, r.title,
            MAX(e.context_usage_percent) AS max_pct,
            AVG(e.context_usage_percent) AS avg_pct,
            COUNT(*) AS events,
            r.input_tokens,
            r.total_cost_usd
     FROM context_events e
     JOIN session_rollups r ON r.conversation_id = e.conversation_id
     WHERE ${w.clause}
     GROUP BY e.conversation_id
     HAVING max_pct > 80
     ORDER BY max_pct DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  if (ctxPressure.length > 0) {
    out += table(
      ["Session", "Title", "Max%", "Avg%", "Events", "Input", "Cost"],
      ctxPressure.map((s) => [
        s.conversation_id.slice(0, 10) + "…",
        (s.title ?? "—").slice(0, 35),
        s.max_pct != null ? `${s.max_pct.toFixed(0)}%` : "—",
        s.avg_pct != null ? `${s.avg_pct.toFixed(0)}%` : "—",
        String(s.events),
        N(s.input_tokens),
        USD(s.total_cost_usd),
      ]),
    );
  } else {
    out += "_No sessions with high context pressure detected._\n";
  }

  // --- Section 9: Global Tool Distribution ---
  out += H2("Top Tools by Usage");
  const topTools = q<{ tool: string; calls: number; sessions: number }>(
    db,
    `SELECT t.tool_name AS tool, COUNT(*) AS calls, COUNT(DISTINCT t.conversation_id) AS sessions
     FROM tool_calls t
     JOIN session_rollups r ON r.conversation_id = t.conversation_id
     WHERE ${w.clause}
     GROUP BY t.tool_name ORDER BY calls DESC LIMIT 20`,
    ...w.params,
  );

  out += table(
    ["Tool", "Calls", "Sessions", "Avg/Session"],
    topTools.map((t) => [
      t.tool,
      N(t.calls),
      String(t.sessions),
      (t.calls / t.sessions).toFixed(1),
    ]),
  );

  // --- Section 10: Deep Dive — Top N Sessions ---
  out += H2(`Deep Dive: Top ${detailN} Most Expensive Sessions`);

  for (let idx = 0; idx < Math.min(detailN, topCost.length); idx++) {
    const s = topCost[idx];
    out += H3(`Session ${idx + 1}: \`${s.conversation_id}\``);

    out += `| Field | Value |\n|-------|-------|\n`;
    out += `| Title | ${s.title ?? "—"} |\n`;
    out += `| Model | ${s.model ?? "—"} |\n`;
    out += `| Profile | ${s.profile ?? "—"} |\n`;
    out += `| Date | ${s.started_at ? D(s.started_at) : "—"} |\n`;
    out += `| Turns | ${s.num_turns} |\n`;
    out += `| Total cost | ${USD(s.total_cost_usd)} |\n`;
    out += `| Input tokens | ${N(s.input_tokens)} |\n`;
    out += `| Output tokens | ${N(s.output_tokens)} |\n`;
    out += `| Avg tokens/turn | ${N(Math.round(s.input_tokens / Math.max(1, s.num_turns)))} |\n\n`;

    // Tool breakdown
    const tools = q<{ tool_name: string; cnt: number; failures: number }>(
      db,
      `SELECT tool_name, COUNT(*) AS cnt, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures
       FROM tool_calls WHERE conversation_id = ? GROUP BY tool_name ORDER BY cnt DESC LIMIT 15`,
      s.conversation_id,
    );

    const totalToolCalls = tools.reduce((a, b) => a + b.cnt, 0);
    out += `**Tool usage** (${totalToolCalls} calls):\n\n`;
    out += table(
      ["Tool", "Calls", "%", "Failures"],
      tools.map((t) => [
        t.tool_name,
        String(t.cnt),
        P(t.cnt, totalToolCalls),
        t.failures > 0 ? String(t.failures) : "",
      ]),
    );
    out += "\n";

    // Token timeline
    const snapshots = q<{
      bubble_id: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      estimated: number;
      created_at: number;
    }>(
      db,
      `SELECT bubble_id, COALESCE(model,'—') AS model,
              input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              estimated, created_at
       FROM token_snapshots WHERE conversation_id = ?
       ORDER BY COALESCE(created_at, 0)`,
      s.conversation_id,
    );

    if (snapshots.length > 0) {
      out += `**Token timeline** (${snapshots.length} snapshots):\n\n`;
      out += table(
        ["#", "Bubble", "Model", "Input", "Output", "CacheR", "CacheW", "Total", "Est"],
        snapshots.map((ts, i) => [
          String(i + 1),
          ts.bubble_id.slice(0, 10) + "…",
          ts.model,
          N(ts.input_tokens),
          N(ts.output_tokens),
          N(ts.cache_read_tokens),
          N(ts.cache_write_tokens),
          N(ts.input_tokens + ts.output_tokens),
          ts.estimated ? "YES" : "",
        ]),
      );
      out += "\n";
    }

    // Context events
    const ctxs = q<{
      context_tokens: number;
      context_usage_percent: number;
      context_window_size: number;
      created_at: number;
    }>(
      db,
      `SELECT context_tokens, context_usage_percent, context_window_size, created_at
       FROM context_events WHERE conversation_id = ? ORDER BY created_at`,
      s.conversation_id,
    );

    if (ctxs.length > 0) {
      out += `**Context pressure** (${ctxs.length} events):\n\n`;
      out += table(
        ["#", "Tokens", "Usage%", "Window", "Time"],
        ctxs.map((c, i) => [
          String(i + 1),
          N(c.context_tokens),
          c.context_usage_percent != null ? `${c.context_usage_percent.toFixed(0)}%` : "—",
          N(c.context_window_size),
          c.created_at ? D(c.created_at).slice(11, 19) : "—",
        ]),
      );
      out += "\n";
    }

    out += `**Turns:** ${s.num_turns} total\n\n`;
  }

  // --- Section 11: First Prompts of Top Sessions ---
  out += H2("First Prompts of Top Cost Sessions");
  const firstPrompts = q<{
    conversation_id: string;
    first_prompt: string;
    total_cost_usd: number;
  }>(
    db,
    `SELECT r.conversation_id, r.first_prompt, r.total_cost_usd
     FROM session_rollups r WHERE ${w.clause} AND r.first_prompt IS NOT NULL
     ORDER BY r.total_cost_usd DESC LIMIT ?`,
    ...w.params,
    topN,
  );

  if (firstPrompts.length > 0) {
    for (const fp of firstPrompts) {
      out += `- **${fp.conversation_id.slice(0, 10)}…** (${USD(fp.total_cost_usd)}): "${(fp.first_prompt ?? "").slice(0, 200)}"\n`;
    }
  }

  // --- Section 12: Data Quality ---
  if (estSessions > 0) {
    out += H2("Data Quality: Estimated Token Sessions");
    const est = q<{
      conversation_id: string;
      title: string;
      total_cost_usd: number;
      input_tokens: number;
    }>(
      db,
      `SELECT r.conversation_id, r.title, r.total_cost_usd, r.input_tokens
       FROM session_rollups r WHERE ${w.clause} AND r.tokens_estimated = 1
       ORDER BY r.total_cost_usd DESC LIMIT ?`,
      ...w.params,
      topN,
    );

    out += `\n**${estSessions} sessions** have estimated tokens (token data missing from state.vscdb). Actual cost may differ.\n\n`;
    out += table(
      ["Session", "Title", "Input (est)", "Cost (est)"],
      est.map((s) => [
        s.conversation_id.slice(0, 10) + "…",
        (s.title ?? "—").slice(0, 45),
        N(s.input_tokens),
        USD(s.total_cost_usd),
      ]),
    );
  }

  // --- Section 13: Root Cause Questions ---
  out += H2("Root Cause Analysis — Questions for Claude");
  out += `
Review the data above and identify the **top 3-5 root causes** of high token usage. For each cause:

1. **Pattern**: What do you see in the data? Cite specific session IDs and numbers.
2. **Root cause hypothesis**: Why does this happen? (agent behavior, prompt structure, tool selection, context accumulation)
3. **Impact estimate**: Rough % of total token/cost waste this explains.
4. **Fix recommendation**: What concrete change would reduce this?

### Key areas to investigate

- **Redundant file reads**: Are the same files read repeatedly within expensive sessions? Look at the reads/turn ratio in deep dives.
- **Search vs graph**: Do expensive sessions use grep/glob when LeanKG semantic search would suffice? Check graph-bypass table.
- **Context bloat**: Do high-input sessions grow from too many accumulated reads? Or verbose initial prompts? Compare input/turn across sessions.
- **Cache misses**: Why do some sessions have near-zero cache reads despite large input? Can cache be warmed?
- **Tool-choice patterns**: Any specific tools that consistently correlate with high token burn?
- **Session lifecycle**: Do long sessions show unbounded token growth per turn? Or are short sessions disproportionately expensive?

\`\`\`
DB path: ${METRICS_DB_PATH}
Query directly with: sqlite3 ${METRICS_DB_PATH}
\`\`\`
`;

  // --- HTML export ---
  const htmlFile = htmlPath ?? (useHtml ? `cursor-token-waste-${new Date().toISOString().slice(0, 10)}.html` : null);
  if (htmlFile) {
    const html = mdToHtml(out);
    Bun.write(htmlFile, html);
    console.error(`[analyze] HTML report written to ${htmlFile}`);
  }

  // --- Output ---
  if (useClaude) {
    const { stdout: claudePath } = Bun.spawnSync({
      cmd: ["which", "claude"],
      stdout: "pipe",
      stderr: "ignore",
    });
    const found =
      claudePath.toString().trim().length > 0;

    if (!found) {
      console.error("[analyze] `claude` CLI not found. Printing report to stdout instead.");
      console.log(out);
    } else {
      console.error("[analyze] Piping report to claude for analysis...");
      const proc = Bun.spawn({
        cmd: ["claude"],
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      });
      const writer = proc.stdin.getWriter();
      await writer.write(new TextEncoder().encode(out));
      await writer.close();
      const code = await proc.exited;
      if (code !== 0) {
        console.error(`\n[analyze] claude exited with code ${code}. Report follows:\n`);
        console.log(out);
      }
    }
  } else if (!htmlFile) {
    console.log(out);
  }

  db.close();
}

// --- naive markdown-to-HTML (no deps) ---
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  const html: string[] = [];
  let inCode = false;
  let inTable = false;
  let tableHtml = "";

  const push = (s: string) => html.push(s);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // code fence
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        push("</code></pre>");
        inCode = false;
      } else {
        push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      push(esc(line));
      continue;
    }

    // table rows
    if (line.startsWith("|")) {
      if (!inTable) {
        inTable = true;
        tableHtml = '<table><thead>';
        // header row
        const hcells = line.split("|").filter(c => c.trim()).map(c => `<th>${esc(c.trim())}</th>`).join("");
        tableHtml += `<tr>${hcells}</tr>`;
        // separator row — skip it
        if (lines[i + 1] && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
          tableHtml += '</thead><tbody>';
          i++; // skip separator
        }
        continue;
      }
      // body row
      const cells = line.split("|").filter(c => c.trim()).map(c => {
        const t = c.trim();
        // bold
        const b = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        return `<td>${b}</td>`;
      }).join("");
      tableHtml += `<tr>${cells}</tr>`;
      continue;
    } else if (inTable) {
      tableHtml += '</tbody></table>';
      push(tableHtml);
      tableHtml = "";
      inTable = false;
      // fall through to process this non-table line
    }

    // headings
    if (line.startsWith("# ")) { push(`<h1>${esc(line.slice(2))}</h1>`); continue; }
    if (line.startsWith("## ")) { push(`<h2>${esc(line.slice(2))}</h2>`); continue; }
    if (line.startsWith("### ")) { push(`<h3>${esc(line.slice(2))}</h3>`); continue; }

    // empty
    if (line.trim() === "") { push("<br>"); continue; }

    // bold + inline code
    let cooked = esc(line);
    cooked = cooked.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    cooked = cooked.replace(/`([^`]+)`/g, "<code>$1</code>");
    cooked = cooked.replace(/^(\s*)-\s/, "$1- ");
    push(`<p>${cooked}</p>`);
  }

  // close pending table
  if (inTable) {
    tableHtml += '</tbody></table>';
    push(tableHtml);
  }
  if (inCode) push("</code></pre>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cursor Token Waste Analysis</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 2rem; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
  h2 { color: #f0883e; margin-top: 2rem; }
  h3 { color: #d2a8ff; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
  th { background: #161b22; color: #8b949e; padding: 8px 12px; text-align: left; border: 1px solid #30363d; }
  td { padding: 6px 12px; border: 1px solid #30363d; }
  tr:hover td { background: #161b22; }
  code { background: #161b22; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #161b22; padding: 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid #30363d; }
  pre code { background: none; padding: 0; }
  p { line-height: 1.6; }
  strong { color: #f0883e; }
  br { display: block; content: ""; margin-top: 0.5rem; }
</style>
</head>
<body>
${html.join("\n")}
</body>
</html>`;
}

main().catch((err) => {
  console.error("analyze failed:", err);
  process.exit(1);
});
