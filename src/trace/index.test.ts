// FILE: src/trace/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-TRACE normalization completeness, determinism (VF-005), malformed handling, and diff behavior.
//   SCOPE: normalizeEvents success/determinism/malformed, diffTraces identical + changed, BLOCK markers
//   DEPENDS: M-TRACE
//   LINKS: V-M-TRACE, VF-005
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   meta - baseline RunTraceInput fixture
//   events - baseline RawEvent[] fixture
//   captureLogger - fake logger recording markers
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import {
  diffTraces,
  normalizeEvents,
  TraceError,
  type GraceLogger,
  type RawEvent,
  type RunTraceInput,
} from "./index.ts";

const meta: RunTraceInput = {
  runId: "run-1",
  experiment: { name: "exp-a", model: "anthropic/claude-opus-4-8" },
  startedAtMs: 1000,
  endedAtMs: 4000,
  status: "success",
  finalOutputText: "done",
  gitDiff: "diff --git a b",
};

const events: RawEvent[] = [
  { type: "message", role: "assistant", text: "thinking", tokens: { input: 10, output: 5 } },
  { type: "tool_call", tool: "edit", ok: true, tokens: { input: 2, output: 0 } },
  { type: "message", role: "tool", text: "edit applied", tokens: { input: 0, output: 3 } },
];

function captureLogger(): { logger: GraceLogger; markers: string[] } {
  const markers: string[] = [];
  const record = (obj: object) => {
    const m = (obj as { marker?: string }).marker;
    if (m) markers.push(m);
  };
  return { logger: { debug: record, info: record, warn: record, error: record }, markers };
}

describe("normalizeEvents", () => {
  // scenario-1 (success): complete RunTrace
  test("folds events into a complete RunTrace", () => {
    const trace = normalizeEvents(meta, events);
    expect(trace.steps).toHaveLength(3);
    expect(trace.tokenUsage).toEqual({ input: 12, output: 8, total: 20 });
    expect(trace.timings.durationMs).toBe(3000);
    expect(trace.finalOutput.text).toBe("done");
    expect(trace.finalOutput.gitDiff).toBe("diff --git a b");
    expect(trace.status).toBe("success");
    expect(trace.partial).toBe(false);
  });

  test("captures tool call ok flag and tool sequence", () => {
    const trace = normalizeEvents(meta, [
      { type: "tool_call", tool: "read", ok: false },
    ]);
    expect(trace.steps[0]).toEqual({ kind: "tool_call", tool: "read", ok: false });
  });

  test("marks a timeout trace partial", () => {
    const trace = normalizeEvents({ ...meta, status: "timeout", partial: true }, events);
    expect(trace.status).toBe("timeout");
    expect(trace.partial).toBe(true);
  });

  // scenario-2 (determinism, VF-005)
  test("is deterministic: identical inputs yield deeply equal traces", () => {
    const a = normalizeEvents(meta, events);
    const b = normalizeEvents(meta, events);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  // scenario-3 (failure): malformed events
  test("rejects a malformed event without corrupting prior steps", () => {
    const bad: RawEvent[] = [
      events[0]!,
      { type: "bogus" } as unknown as RawEvent,
    ];
    expect(() => normalizeEvents(meta, bad)).toThrow(TraceError);
  });

  test("rejects a tool_call without a tool name", () => {
    expect(() => normalizeEvents(meta, [{ type: "tool_call", tool: "" } as RawEvent])).toThrow(TraceError);
  });

  test("emits BLOCK_NORMALIZE_EVENTS marker", () => {
    const { logger, markers } = captureLogger();
    normalizeEvents(meta, events, logger);
    expect(markers).toContain("BLOCK_NORMALIZE_EVENTS");
  });
});

describe("diffTraces", () => {
  // identical traces -> no differences (VF-005 invariant)
  test("reports identical=true for two identical traces", () => {
    const a = normalizeEvents(meta, events);
    const b = normalizeEvents(meta, events);
    const d = diffTraces(a, b);
    expect(d.identical).toBe(true);
    expect(d.stepCountDelta).toBe(0);
    expect(d.tokenTotalDelta).toBe(0);
    expect(d.toolSequenceChanged).toBe(false);
  });

  test("detects status, token, output, and tool-sequence changes", () => {
    const a = normalizeEvents(meta, events);
    const b = normalizeEvents(
      { ...meta, status: "error", finalOutputText: "failed", error: "boom" },
      [{ type: "tool_call", tool: "bash", ok: false, tokens: { input: 1, output: 1 } }],
    );
    const d = diffTraces(a, b);
    expect(d.identical).toBe(false);
    expect(d.statusChanged).toBe(true);
    expect(d.finalOutputChanged).toBe(true);
    expect(d.toolSequenceChanged).toBe(true);
    expect(d.stepCountDelta).toBe(b.steps.length - a.steps.length);
  });

  test("emits BLOCK_DIFF_TRACES marker", () => {
    const { logger, markers } = captureLogger();
    const a = normalizeEvents(meta, events);
    diffTraces(a, a, logger);
    expect(markers).toContain("BLOCK_DIFF_TRACES");
  });
});
