// FILE: src/mcp/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-MCP tool handlers dispatch to the engine/store, return text+structured results, and isolate errors.
//   SCOPE: run_experiment/list_runs/get_run/compare_runs success + error, BLOCK_HANDLE_TOOL marker, server builds
//   DEPENDS: M-MCP, M-STORE, M-LOGGER
//   LINKS: V-M-MCP
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   memStore - in-memory TraceStore fake
//   collectLines - capture pino markers
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-MCP tests (tool dispatch, error isolation, server build).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger/index.ts";
import type { StoredRun, TraceStore } from "../store/index.ts";
import type { RunTrace } from "../trace/index.ts";
import { createMcpServer, createToolHandlers, MCP_TOOL_FAILED } from "./index.ts";

function trace(runId: string, tools: string[] = ["edit"]): RunTrace {
  return {
    runId,
    experiment: { name: "exp", model: "a/b" },
    status: "success",
    partial: false,
    timings: { startedAtMs: 0, endedAtMs: 1, durationMs: 1 },
    steps: tools.map((t) => ({ kind: "tool_call" as const, tool: t, ok: true })),
    tokenUsage: { input: 1, output: 1, total: 2 },
    finalOutput: { text: "done" },
  };
}

function storedRun(runId: string, tools?: string[]): StoredRun {
  return {
    runId,
    experiment: { name: "exp", model: "anthropic/claude-opus-4-8", systemPrompt: "sp", taskPrompt: "tp" },
    status: "success",
    timings: trace(runId).timings,
    trace: trace(runId, tools),
  };
}

function memStore(seed: StoredRun[] = []): TraceStore {
  const saved = new Map<string, StoredRun>(seed.map((r) => [r.runId, r]));
  return {
    async saveRun(run) {
      saved.set(run.runId, run);
    },
    async getRun(runId) {
      const r = saved.get(runId);
      if (!r) throw new Error("not found");
      return r;
    },
    async listRuns() {
      return [...saved.values()].map((r) => ({ runId: r.runId, name: r.experiment.name, model: r.experiment.model, status: r.status }));
    },
  };
}

function collectLines() {
  const objects: Array<Record<string, unknown>> = [];
  const dest = {
    write(s: string) {
      for (const line of s.split("\n")) if (line.trim()) objects.push(JSON.parse(line));
    },
  };
  return { dest, markers: () => objects.map((o) => o.marker).filter(Boolean) as string[] };
}

const silent = createLogger({ level: "silent" });

describe("createToolHandlers", () => {
  test("run_experiment dispatches to the injected engine and returns structured content", async () => {
    const sink = collectLines();
    let received: unknown;
    const run = (async (def: unknown) => {
      received = def;
      return [{ runId: "run-1", name: "exp", status: "success" as const }];
    }) as never;

    const h = createToolHandlers({ logger: createLogger({ destination: sink.dest }), store: memStore(), run });
    const res = await h.run_experiment({ systemPrompt: "sp", model: "anthropic/claude-opus-4-8", taskPrompt: "tp" });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.results).toBeDefined();
    expect((received as { model: string }).model).toBe("anthropic/claude-opus-4-8");
    expect(sink.markers()).toContain("BLOCK_HANDLE_TOOL");
  });

  test("run_experiment passes sandbox options when provided", async () => {
    let received: { sandbox?: { networkAllowlist?: string[]; timeoutMs?: number } } | undefined;
    const run = (async (def: unknown) => {
      received = def as typeof received;
      return [];
    }) as never;
    const h = createToolHandlers({ logger: silent, store: memStore(), run });
    await h.run_experiment({
      systemPrompt: "s",
      model: "a/b",
      taskPrompt: "t",
      networkAllowlist: ["cpa.funxyz.fun"],
      timeoutMs: 60000,
    });
    expect(received?.sandbox?.networkAllowlist).toEqual(["cpa.funxyz.fun"]);
    expect(received?.sandbox?.timeoutMs).toBe(60000);
  });

  test("list_runs returns known runs", async () => {
    const h = createToolHandlers({ logger: silent, store: memStore([storedRun("run-1")]) });
    const res = await h.list_runs();
    expect((res.structuredContent?.runs as unknown[])).toHaveLength(1);
  });

  test("get_run returns the run", async () => {
    const h = createToolHandlers({ logger: silent, store: memStore([storedRun("run-1")]) });
    const res = await h.get_run({ runId: "run-1" });
    expect((res.structuredContent?.run as { runId: string }).runId).toBe("run-1");
  });

  test("compare_runs diffs via the injected comparator", async () => {
    const h = createToolHandlers({
      logger: silent,
      store: memStore([storedRun("run-1", ["edit"]), storedRun("run-2", ["bash", "edit"])]),
    });
    const res = await h.compare_runs({ runIds: ["run-1", "run-2"] });
    expect(res.structuredContent?.baselineRunId).toBe("run-1");
  });

  // error isolation: a failing engine call surfaces MCP_TOOL_FAILED, does not throw
  test("surfaces MCP_TOOL_FAILED instead of throwing", async () => {
    const h = createToolHandlers({ logger: silent, store: memStore() });
    const res = await h.get_run({ runId: "missing" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain(MCP_TOOL_FAILED);
  });

  test("invalid experiment input is reported as a tool error, not a crash", async () => {
    const run = (async () => []) as never;
    const h = createToolHandlers({ logger: silent, store: memStore(), run });
    const res = await h.run_experiment({ systemPrompt: "", model: "a/b", taskPrompt: "t" });
    expect(res.isError).toBe(true);
  });
});

describe("createMcpServer", () => {
  test("builds a server with the tools registered (no throw)", () => {
    const server = createMcpServer({ logger: silent, store: memStore() });
    expect(server).toBeDefined();
  });
});
