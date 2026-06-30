// FILE: src/engine/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-ENGINE single/parallel orchestration, concurrency bound, failure isolation, persistence, and compare.
//   SCOPE: runExperiment single+parallel, bound never exceeded, sibling isolation, no-success-on-failure, compareRuns
//   DEPENDS: M-ENGINE, M-CONFIG, M-STORE, M-LOGGER
//   LINKS: V-M-ENGINE
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   memStore - in-memory TraceStore fake
//   makeTrace - RunTrace builder
//   makeDef - ExperimentDefinition builder
//   collectLines - capture pino markers
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-ENGINE tests (orchestration, bound, isolation, compare).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { ExperimentDefinition } from "../config/index.ts";
import { createLogger } from "../logger/index.ts";
import type { StoredRun, TraceStore } from "../store/index.ts";
import type { RunStatus, RunTrace } from "../trace/index.ts";
import { compareRuns, runExperiment, type RunExecutor } from "./index.ts";

function memStore(): TraceStore & { saved: Map<string, StoredRun> } {
  const saved = new Map<string, StoredRun>();
  return {
    saved,
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

function makeTrace(runId: string, status: RunStatus = "success", toolSeq: string[] = ["edit"]): RunTrace {
  return {
    runId,
    experiment: { name: "exp", model: "a/b" },
    status,
    partial: false,
    timings: { startedAtMs: 0, endedAtMs: 1, durationMs: 1 },
    steps: toolSeq.map((t) => ({ kind: "tool_call", tool: t, ok: true })),
    tokenUsage: { input: 1, output: 1, total: 2 },
    finalOutput: { text: status },
  };
}

function makeDef(name: string): ExperimentDefinition {
  return {
    name,
    systemPrompt: "sp",
    model: "anthropic/claude-opus-4-8",
    taskPrompt: "tp",
    sandbox: { image: "img", networkAllowlist: [], timeoutMs: 1000 },
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

const seqIds = () => {
  let n = 0;
  return () => `run-${++n}`;
};

describe("runExperiment", () => {
  // scenario-1 (success): single run end to end, persisted
  test("runs a single experiment and persists it", async () => {
    const sink = collectLines();
    const store = memStore();
    const executor: RunExecutor = { async execute({ runId }) { return makeTrace(runId); } };

    const results = await runExperiment(makeDef("a"), {
      logger: createLogger({ destination: sink.dest }),
      store,
      executor,
      idGen: seqIds(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
    expect(store.saved.size).toBe(1);
    expect(sink.markers()).toContain("BLOCK_SCHEDULE_RUNS");
  });

  // scenario-2 (success): N parallel, concurrency never exceeds the bound
  test("never exceeds the concurrency bound across N runs", async () => {
    const store = memStore();
    let active = 0;
    let maxActive = 0;
    const executor: RunExecutor = {
      async execute({ runId }) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return makeTrace(runId);
      },
    };
    const defs = Array.from({ length: 10 }, (_, i) => makeDef(`e${i}`));

    const results = await runExperiment(defs, {
      logger: createLogger({ level: "silent" }),
      store,
      executor,
      concurrency: 3,
      idGen: seqIds(),
    });

    expect(results).toHaveLength(10);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(store.saved.size).toBe(10);
  });

  // scenario-3 (failure isolation): one run's failure does not abort siblings; not persisted as success
  test("isolates a failing run and still persists siblings", async () => {
    const store = memStore();
    const executor: RunExecutor = {
      async execute({ runId, experiment }) {
        if (experiment.name === "boom") throw new Error("executor blew up");
        return makeTrace(runId);
      },
    };
    const defs = [makeDef("ok1"), makeDef("boom"), makeDef("ok2")];

    const results = await runExperiment(defs, {
      logger: createLogger({ level: "silent" }),
      store,
      executor,
      concurrency: 2,
      idGen: seqIds(),
    });

    const boom = results.find((r) => r.name === "boom");
    expect(boom?.status).toBe("start_failed");
    expect(boom?.error).toContain("executor blew up");
    // siblings completed and persisted
    expect(results.filter((r) => r.status === "success")).toHaveLength(2);
    expect(store.saved.size).toBe(2); // failed run not persisted (never as success)
    for (const saved of store.saved.values()) expect(saved.status).toBe("success");
  });

  // a non-success trace is persisted with its real status (not success)
  test("persists an error-status run with status=error", async () => {
    const store = memStore();
    const executor: RunExecutor = { async execute({ runId }) { return makeTrace(runId, "error"); } };
    await runExperiment(makeDef("e"), {
      logger: createLogger({ level: "silent" }),
      store,
      executor,
      idGen: seqIds(),
    });
    expect([...store.saved.values()][0]?.status).toBe("error");
  });
});

describe("compareRuns", () => {
  test("diffs each run against the baseline", async () => {
    const store = memStore();
    await store.saveRun({ runId: "run-1", experiment: { name: "a", model: "a/b", systemPrompt: "s", taskPrompt: "t" }, status: "success", timings: makeTrace("run-1").timings, trace: makeTrace("run-1", "success", ["edit"]) });
    await store.saveRun({ runId: "run-2", experiment: { name: "b", model: "a/b", systemPrompt: "s", taskPrompt: "t" }, status: "success", timings: makeTrace("run-2").timings, trace: makeTrace("run-2", "success", ["bash", "edit"]) });

    const cmp = await compareRuns(["run-1", "run-2"], { logger: createLogger({ level: "silent" }), store });
    expect(cmp.baselineRunId).toBe("run-1");
    expect(cmp.diffs).toHaveLength(1);
    expect(cmp.diffs[0]?.diff.toolSequenceChanged).toBe(true);
  });

  test("rejects fewer than two run ids", async () => {
    const store = memStore();
    await expect(compareRuns(["only"], { logger: createLogger({ level: "silent" }), store })).rejects.toThrow();
  });
});
