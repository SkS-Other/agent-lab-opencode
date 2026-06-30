// FILE: src/trace/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Normalize raw OpenCode session events into a stable RunTrace and diff two traces, independent of the SDK surface.
//   SCOPE: normalizeEvents, diffTraces, RunTrace/TraceDiff/RunStep types, TraceError
//   DEPENDS: none
//   LINKS: M-TRACE, V-M-TRACE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   normalizeEvents - fold raw OpenCode events into a deterministic RunTrace
//   diffTraces - structurally compare two RunTraces
//   RunTrace - stable normalized trace (steps, tokenUsage, finalOutput, status, timings)
//   RunStep - one normalized step (message or tool call)
//   TraceDiff - structured behavior/outcome comparison
//   RawEvent - minimal shape M-OPENCODE feeds in
//   TraceError - typed error carrying TRACE_MALFORMED_EVENT
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-TRACE: deterministic normalization + structural diff with BLOCK markers.
// END_CHANGE_SUMMARY

/** Minimal structural logger; pino.Logger satisfies it. Local copy keeps M-TRACE DEPENDS=none. */
export interface GraceLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const TRACE_MALFORMED_EVENT = "TRACE_MALFORMED_EVENT" as const;

export class TraceError extends Error {
  readonly code = TRACE_MALFORMED_EVENT;
  constructor(message: string) {
    super(message);
    this.name = "TraceError";
  }
}

export type RunStatus = "success" | "error" | "timeout";

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export type RunStep =
  | { kind: "message"; role: "assistant" | "tool"; text: string; tokens?: number }
  | { kind: "tool_call"; tool: string; ok: boolean; tokens?: number };

export interface RunTraceInput {
  runId: string;
  experiment: { name: string; model: string; systemPromptHash?: string; taskPromptHash?: string };
  startedAtMs: number;
  endedAtMs: number;
  status: RunStatus;
  finalOutputText: string;
  gitDiff?: string;
  error?: string;
  /** True when the run hit its deadline; the trace is partial-but-marked. */
  partial?: boolean;
}

export interface RunTrace {
  runId: string;
  experiment: RunTraceInput["experiment"];
  status: RunStatus;
  partial: boolean;
  timings: { startedAtMs: number; endedAtMs: number; durationMs: number };
  steps: RunStep[];
  tokenUsage: TokenUsage;
  finalOutput: { text: string; gitDiff?: string };
  error?: string;
}

/** Minimal raw event shape; M-OPENCODE adapts SDK events to this before handing them in. */
export type RawEvent =
  | { type: "message"; role: "assistant" | "tool"; text: string; tokens?: { input?: number; output?: number } }
  | { type: "tool_call"; tool: string; ok?: boolean; tokens?: { input?: number; output?: number } };

export interface TraceDiff {
  identical: boolean;
  statusChanged: boolean;
  stepCountDelta: number;
  tokenTotalDelta: number;
  finalOutputChanged: boolean;
  toolSequenceChanged: boolean;
}

// START_CONTRACT: normalizeEvents
//   PURPOSE: Fold an ordered list of raw OpenCode events into a deterministic RunTrace.
//   INPUTS: { meta: RunTraceInput - run-level facts, events: RawEvent[] - ordered raw events, logger?: GraceLogger }
//   OUTPUTS: { RunTrace - normalized, deterministic for identical inputs }
//   SIDE_EFFECTS: none (pure; only optional logging)
//   LINKS: M-TRACE, V-M-TRACE, TRACE_MALFORMED_EVENT
// END_CONTRACT: normalizeEvents
export function normalizeEvents(meta: RunTraceInput, events: RawEvent[], logger?: GraceLogger): RunTrace {
  // START_BLOCK_NORMALIZE_EVENTS
  logger?.debug(
    { marker: "BLOCK_NORMALIZE_EVENTS", runId: meta.runId, eventCount: events.length },
    "[Trace][normalizeEvents][BLOCK_NORMALIZE_EVENTS] folding events",
  );

  if (!Array.isArray(events)) {
    throw new TraceError("events must be an array");
  }

  const steps: RunStep[] = [];
  let input = 0;
  let output = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") {
      throw new TraceError(`malformed event at index ${i}`);
    }
    if (ev.type === "message") {
      if (ev.role !== "assistant" && ev.role !== "tool") {
        throw new TraceError(`message event at index ${i} has invalid role`);
      }
      if (typeof ev.text !== "string") {
        throw new TraceError(`message event at index ${i} missing text`);
      }
      const tokens = sumTokens(ev.tokens);
      input += ev.tokens?.input ?? 0;
      output += ev.tokens?.output ?? 0;
      steps.push({ kind: "message", role: ev.role, text: ev.text, ...(tokens !== undefined ? { tokens } : {}) });
    } else if (ev.type === "tool_call") {
      if (typeof ev.tool !== "string" || ev.tool === "") {
        throw new TraceError(`tool_call event at index ${i} missing tool name`);
      }
      const tokens = sumTokens(ev.tokens);
      input += ev.tokens?.input ?? 0;
      output += ev.tokens?.output ?? 0;
      steps.push({ kind: "tool_call", tool: ev.tool, ok: ev.ok ?? true, ...(tokens !== undefined ? { tokens } : {}) });
    } else {
      throw new TraceError(`unknown event type "${(ev as { type: string }).type}" at index ${i}`);
    }
  }

  const durationMs = Math.max(0, meta.endedAtMs - meta.startedAtMs);
  const trace: RunTrace = {
    runId: meta.runId,
    experiment: meta.experiment,
    status: meta.status,
    partial: meta.partial ?? false,
    timings: { startedAtMs: meta.startedAtMs, endedAtMs: meta.endedAtMs, durationMs },
    steps,
    tokenUsage: { input, output, total: input + output },
    finalOutput: { text: meta.finalOutputText, ...(meta.gitDiff !== undefined ? { gitDiff: meta.gitDiff } : {}) },
    ...(meta.error !== undefined ? { error: meta.error } : {}),
  };
  return trace;
  // END_BLOCK_NORMALIZE_EVENTS
}

// START_CONTRACT: diffTraces
//   PURPOSE: Produce a structural diff of two RunTraces (no exact agent-text equality assumptions).
//   INPUTS: { a: RunTrace, b: RunTrace, logger?: GraceLogger }
//   OUTPUTS: { TraceDiff - structural comparison; identical=true when no tracked field differs }
//   SIDE_EFFECTS: none (pure; only optional logging)
//   LINKS: M-TRACE, V-M-TRACE
// END_CONTRACT: diffTraces
export function diffTraces(a: RunTrace, b: RunTrace, logger?: GraceLogger): TraceDiff {
  // START_BLOCK_DIFF_TRACES
  const statusChanged = a.status !== b.status;
  const stepCountDelta = b.steps.length - a.steps.length;
  const tokenTotalDelta = b.tokenUsage.total - a.tokenUsage.total;
  const finalOutputChanged = a.finalOutput.text !== b.finalOutput.text;
  const toolSequenceChanged = toolSequence(a) !== toolSequence(b);

  const identical =
    !statusChanged && stepCountDelta === 0 && tokenTotalDelta === 0 && !finalOutputChanged && !toolSequenceChanged;

  logger?.debug(
    { marker: "BLOCK_DIFF_TRACES", identical },
    "[Trace][diffTraces][BLOCK_DIFF_TRACES] compared",
  );
  return { identical, statusChanged, stepCountDelta, tokenTotalDelta, finalOutputChanged, toolSequenceChanged };
  // END_BLOCK_DIFF_TRACES
}

// --- private helpers ---

function sumTokens(tokens?: { input?: number; output?: number }): number | undefined {
  if (tokens === undefined) return undefined;
  return (tokens.input ?? 0) + (tokens.output ?? 0);
}

function toolSequence(trace: RunTrace): string {
  return trace.steps
    .filter((s): s is Extract<RunStep, { kind: "tool_call" }> => s.kind === "tool_call")
    .map((s) => s.tool)
    .join(",");
}
