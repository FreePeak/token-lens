import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sessions } from "./Sessions";
import { api } from "../api";
import type { SessionRollup } from "../api";

vi.mock("../api", () => ({
  api: {
    sessions: vi.fn(),
  },
  fmtCost: vi.fn((n: number) => `$${n.toFixed(2)}`),
  fmtDate: vi.fn((ms: number | null) => (ms ? "Jul 30, 14:30" : "—")),
  fmtDuration: vi.fn((ms: number | null) => (ms ? "1m30s" : "—")),
  fmtNum: vi.fn((n: number) => String(Math.round(n))),
  shortTitle: vi.fn((s: SessionRollup) => s.title ?? s.workspace_path ?? s.workspace ?? "unknown"),
}));

const mockSession: SessionRollup = {
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
};

describe("Sessions copy button", () => {
  beforeEach(() => {
    vi.mocked(api.sessions).mockResolvedValue([mockSession]);
  });

  it("renders copy button for each session row", async () => {
    render(
      <Sessions days={7} profile=".cursor" onError={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(await screen.findByTitle("Copy session path")).toBeInTheDocument();
  });

  it("shows green icon after click (feedback)", async () => {
    const user = userEvent.setup();
    render(
      <Sessions days={7} profile=".cursor" onError={vi.fn()} onOpen={vi.fn()} />,
    );
    const btn = await screen.findByTitle("Copy session path");
    await user.click(btn);
    const icon = btn.querySelector("svg");
    const classes = icon?.getAttribute("class") ?? "";
    expect(classes).toContain("text-green-500");
  });

  it("does not navigate when copy button clicked", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(
      <Sessions days={7} profile=".cursor" onError={vi.fn()} onOpen={onOpen} />,
    );
    const btn = await screen.findByTitle("Copy session path");
    await user.click(btn);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
