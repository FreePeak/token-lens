import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Detail } from "./Detail";
import { api } from "../api";
import type { SessionDetail } from "../api";

vi.mock("../api", () => ({
  api: {
    session: vi.fn(),
  },
  fmtCost: vi.fn((n: number) => `$${n.toFixed(2)}`),
  fmtDate: vi.fn((ms: number | null) => (ms ? "Jul 30, 14:30" : "—")),
  fmtNum: vi.fn((n: number) => String(Math.round(n))),
  shortTitle: vi.fn((s: { title?: string | null; workspace_path?: string | null; workspace?: string | null }) => s.title ?? "unknown"),
}));

const mockDetail: SessionDetail = {
  conversation_id: "abc-123",
  title: "Test session",
  workspace: "hash123",
  workspace_path: "/Users/test/work/project",
  model: "claude-sonnet-4-20250514",
  mode: "agent",
  started_at: 1722000000000,
  ended_at: 1722000300000,
  duration_ms: 300000,
  num_turns: 10,
  tool_calls: 5,
  file_reads: 3,
  input_tokens: 5000,
  output_tokens: 2000,
  total_tokens: 7000,
  total_cost_usd: 0.05,
  profile: ".cursor",
  turns: [{ generation_id: "gen-1", status: "completed", started_at: 1722000000000, ended_at: 1722000100000 }],
  tools: [{ tool_name: "read", count: 3, failures: 0 }],
  token_snapshots: [{ bubble_id: "b1", input_tokens: 500, output_tokens: 200, context_tokens: null, model: "claude", created_at: 1722000000000, prompt: "hello" }],
  context_events: [],
};

describe("Detail copy button", () => {
  beforeEach(() => {
    vi.mocked(api.session).mockResolvedValue(mockDetail);
  });

  it("renders copy button", async () => {
    render(<Detail id="abc-123" onError={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText("Copy session path")).toBeInTheDocument();
  });

  it("shows Copied! after click", async () => {
    const user = userEvent.setup();
    render(<Detail id="abc-123" onError={vi.fn()} onBack={vi.fn()} />);
    const btn = await screen.findByText("Copy session path");
    await user.click(btn);
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("green icon after click", async () => {
    const user = userEvent.setup();
    render(<Detail id="abc-123" onError={vi.fn()} onBack={vi.fn()} />);
    const btn = await screen.findByText("Copy session path");
    await user.click(btn);
    const icon = btn.querySelector("svg");
    const classes = icon?.getAttribute("class") ?? "";
    expect(classes).toContain("text-green-500");
  });
});
