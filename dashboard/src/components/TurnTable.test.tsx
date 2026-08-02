import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TurnTable } from "./TurnTable";
import { ContextEventsTimeline } from "./ContextEventsTimeline";
import type { SessionDetail } from "../api";

vi.mock("../api", () => ({
  fmtCost: (n: number) => `$${n.toFixed(2)}`,
  fmtNum: (n: number) => {
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(Math.round(n));
  },
  fmtDate: (_ms: number | null) => "Jul 30",
}));

const baseTurn = {
  generation_id: "g1",
  status: "responded",
  started_at: 1722000000000,
  ended_at: 1722000100000,
};

describe("TurnTable", () => {
  it("renders one row per turn with input/output/cache/cost", () => {
    const detail = {
      conversation_id: "c1",
      title: null,
      workspace: null,
      workspace_path: null,
      model: null,
      mode: null,
      started_at: null,
      ended_at: null,
      duration_ms: null,
      num_turns: 2,
      tool_calls: 0,
      file_reads: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      profile: null,
      turns: [
        { ...baseTurn, generation_id: "g1", input_tokens: 1000, output_tokens: 200, total_tokens: 1200, total_cost_usd: 0.05, model: "claude-sonnet-4-5-20250929", estimated: 0 },
        { ...baseTurn, generation_id: "g2", input_tokens: 5000, output_tokens: 1000, cache_read_tokens: 4000, total_tokens: 10000, total_cost_usd: 0.21, model: "claude-sonnet-4-5-20250929", estimated: 0 },
      ],
      tools: [],
      token_snapshots: [],
      context_events: [],
      root_causes: [],
    } as unknown as SessionDetail;

    render(<TurnTable detail={detail} />);
    expect(screen.getByText("Turns (2)")).toBeInTheDocument();
    // generation_id is truncated to 12 chars + …
    expect(screen.getByText(/g1[\s\S]*…?/)).toBeInTheDocument();
    // fmtNum: 1000 → "1.0k" appears in both input and total cells
    expect(screen.getAllByText("1.0k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5.0k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4.0k").length).toBeGreaterThan(0);
    expect(screen.getByText("$0.05")).toBeInTheDocument();
    expect(screen.getByText("$0.21")).toBeInTheDocument();
  });

  it("prefixes estimated values with ~", () => {
    const detail = {
      ...({
        conversation_id: "c1",
        title: null,
        workspace: null,
        workspace_path: null,
        model: null,
        mode: null,
        started_at: null,
        ended_at: null,
        duration_ms: null,
        num_turns: 1,
        tool_calls: 0,
        file_reads: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        profile: null,
        turns: [
          { ...baseTurn, generation_id: "ge1", input_tokens: 9000, output_tokens: 0, total_tokens: 9000, total_cost_usd: 0.13, estimated: 1, model: "gpt-4" },
        ],
        tools: [],
        token_snapshots: [],
        context_events: [],
        root_causes: [],
      } as unknown as SessionDetail),
    };
    render(<TurnTable detail={detail} />);
    // ~9.0k renders (fmtNum(9000) = "9.0k", prefixed with ~)
    expect(screen.getAllByText(/~9\.0k/).length).toBeGreaterThan(0);
    expect(screen.getByText(/~\$0\.13/)).toBeInTheDocument();
  });

  it("shows a placeholder when there are no turns", () => {
    const detail = {
      conversation_id: "c1",
      title: null,
      workspace: null,
      workspace_path: null,
      model: null,
      mode: null,
      started_at: null,
      ended_at: null,
      duration_ms: null,
      num_turns: 0,
      tool_calls: 0,
      file_reads: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      profile: null,
      turns: [],
      tools: [],
      token_snapshots: [],
      context_events: [],
      root_causes: [],
    } as unknown as SessionDetail;
    render(<TurnTable detail={detail} />);
    expect(screen.getByText(/No turn cost data yet\./)).toBeInTheDocument();
  });
});

describe("ContextEventsTimeline", () => {
  it("renders a row per event and shows max percent", () => {
    const detail = {
      ...({
        conversation_id: "c1",
        title: null,
        workspace: null,
        workspace_path: null,
        model: null,
        mode: null,
        started_at: null,
        ended_at: null,
        duration_ms: null,
        num_turns: 0,
        tool_calls: 0,
        file_reads: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        total_cost_usd: 0,
        profile: null,
        turns: [],
        tools: [],
        token_snapshots: [],
        context_events: [
          { id: 1, context_tokens: 100_000, context_usage_percent: 40, context_window_size: 250_000, created_at: 1722000000000 },
          { id: 2, context_tokens: 220_000, context_usage_percent: 88, context_window_size: 250_000, created_at: 1722001000000 },
        ],
        root_causes: [],
      } as unknown as SessionDetail),
    };
    render(<ContextEventsTimeline detail={detail} />);
    expect(screen.getByText(/Context events \(2\)/)).toBeInTheDocument();
    // max percent badge
    expect(screen.getByText(/88% max/)).toBeInTheDocument();
  });

  it("renders nothing when no events", () => {
    const detail = {
      conversation_id: "c1",
      title: null,
      workspace: null,
      workspace_path: null,
      model: null,
      mode: null,
      started_at: null,
      ended_at: null,
      duration_ms: null,
      num_turns: 0,
      tool_calls: 0,
      file_reads: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      profile: null,
      turns: [],
      tools: [],
      token_snapshots: [],
      context_events: [],
      root_causes: [],
    } as unknown as SessionDetail;
    render(<ContextEventsTimeline detail={detail} />);
    expect(screen.queryByText(/Context events/)).not.toBeInTheDocument();
  });
});
