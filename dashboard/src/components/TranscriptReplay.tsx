import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  makeAssistantToolUI,
  useLocalRuntime,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { fmtLatency, fmtNum, type SessionDetail } from "../api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Read-only replay of a session's tool calls, rendered with assistant-ui's
 * thread primitives so it reads like the agent's own transcript.
 *
 * The runtime is a no-op LocalRuntime (`run` never fires — there is no model
 * to call); its only job is to turn our stored `tool-call` parts into
 * assistant messages that the thread UI renders.
 */

const TOOL_NAME = "recorded_tool";

type ReplayPart = { tool: string; ms: number | null; ttfb: number | null; ok: boolean; req: string | null; res: string | null; truncated: boolean; text: string };

/** One recorded tool call as a thread assistant message. */
function toMessagePart(call: SessionDetail["tool_calls"][number], index: number) {
  const part: ReplayPart = {
    tool: call.tool_name,
    ms: call.duration_ms,
    ttfb: call.ttfb_ms,
    ok: call.success !== 0,
    req: call.request,
    res: call.response,
    truncated: call.truncated === 1,
    text: "",
  };
  return {
    role: "assistant" as const,
    id: `call-${call.id ?? index}`,
    createdAt: new Date(call.created_at || Date.now()),
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `call-${call.id ?? index}`,
        toolName: TOOL_NAME,
        args: part as unknown as Record<string, never>,
        result: call.response ?? undefined,
        isError: call.success === 0,
      },
    ],
  };
}

/** The renderer for our synthetic tool-call parts. */
function ToolCallCard({
  args,
  result,
  isError,
}: ToolCallMessagePartProps<ReplayPart, string>) {
  const p = args;
  return (
    <div className="my-2 border border-border bg-card" data-testid="replay-tool-call">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-sm font-semibold">{p.tool}</span>
        <Badge variant="outline" className="text-[10px]">
          {fmtLatency(p.ms)}
        </Badge>
        {p.ttfb != null && (
          <Badge variant="outline" className="text-[10px]">
            ttfb {fmtLatency(p.ttfb)}
          </Badge>
        )}
        {isError ? (
          <Badge variant="outline" className="text-[10px] text-destructive border-destructive/50">
            failed
          </Badge>
        ) : null}
        {p.truncated ? (
          <Badge variant="outline" className="text-[10px]">
            capped
          </Badge>
        ) : null}
      </div>
      <div className="space-y-2 p-3">
        {p.req && (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              request
            </p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all bg-secondary p-2 font-mono text-[11px]">
              {p.req}
            </pre>
          </div>
        )}
        {result ? (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              response
            </p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all bg-secondary/60 p-2 font-mono text-[11px]">
              {result}
            </pre>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No response captured.</p>
        )}
      </div>
    </div>
  );
}

const RecordedToolUI = makeAssistantToolUI<ReplayPart, string>({
  toolName: TOOL_NAME,
  render: ToolCallCard,
});

export function TranscriptReplay({ detail }: { detail: SessionDetail }) {
  const messages = useMemo(
    () => detail.tool_calls.map((c, i) => toMessagePart(c, i)),
    [detail.tool_calls],
  );

  const runtime = useLocalRuntime({
    // No model to run: this is a replay, so `run` is never invoked.
    run: async function* () {
      /* unreachable for a read-only transcript */
    },
    initialMessages: messages,
  });

  if (!detail.tool_calls.length) {
    return <p className="text-sm text-muted-foreground">No tool calls captured.</p>;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RecordedToolUI />
      <ThreadPrimitive.Root className="aui-thread-root">
        <ThreadPrimitive.Viewport className="max-h-[70vh] overflow-y-auto px-1">
          <ThreadPrimitive.Messages
            components={{
              AssistantMessage: ({ children }) => (
                <div className="py-1">{children}</div>
              ),
            }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

export function TranscriptCard({ detail }: { detail: SessionDetail }) {
  const withBodies = detail.tool_calls.filter((c) => c.request || c.response).length;
  return (
    <Card className="rounded-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">
          Tool call replay ({fmtNum(detail.tool_calls.length)})
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {fmtNum(withBodies)} with captured request/response
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <TranscriptReplay detail={detail} />
      </CardContent>
    </Card>
  );
}
