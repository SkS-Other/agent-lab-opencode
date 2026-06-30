// FILE: src/store/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-STORE round-trip, listing, not-found, persisted-secret-absence, and BLOCK_PERSIST_RUN marker.
//   SCOPE: saveRun/getRun round-trip, listRuns, STORE_NOT_FOUND, no secret leak, replay metadata
//   DEPENDS: M-STORE, M-LOGGER
//   LINKS: V-M-STORE
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   tmpBase - create a unique temp base directory per test
//   sampleRun - StoredRun fixture
//   collectLines - capture pino markers
// END_MODULE_MAP

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger/index.ts";
import { createStore, STORE_NOT_FOUND, StoreError, type StoredRun } from "./index.ts";
import type { RunTrace } from "../trace/index.ts";

const dirs: string[] = [];
async function tmpBase(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-lab-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function collectLines() {
  const objects: Array<Record<string, unknown>> = [];
  const dest = {
    write(s: string) {
      for (const line of s.split("\n")) if (line.trim()) objects.push(JSON.parse(line));
    },
  };
  return { dest, markers: () => objects.map((o) => o.marker).filter(Boolean) as string[] };
}

const trace: RunTrace = {
  runId: "run-1",
  experiment: { name: "exp-a", model: "anthropic/claude-opus-4-8" },
  status: "success",
  partial: false,
  timings: { startedAtMs: 0, endedAtMs: 1000, durationMs: 1000 },
  steps: [{ kind: "tool_call", tool: "edit", ok: true }],
  tokenUsage: { input: 1, output: 1, total: 2 },
  finalOutput: { text: "done" },
};

const sampleRun: StoredRun = {
  runId: "run-1",
  experiment: {
    name: "exp-a",
    model: "anthropic/claude-opus-4-8",
    systemPrompt: "You are careful.",
    taskPrompt: "Fix the bug.",
  },
  status: "success",
  timings: trace.timings,
  trace,
};

describe("createStore", () => {
  // scenario-1 (success): round-trip
  test("saveRun then getRun round-trips the record", async () => {
    const sink = collectLines();
    const store = createStore({ logger: createLogger({ destination: sink.dest }), baseDir: await tmpBase() });

    await store.saveRun(sampleRun);
    const loaded = await store.getRun("run-1");

    expect(loaded.runId).toBe("run-1");
    expect(loaded.status).toBe("success");
    expect(loaded.trace.steps).toHaveLength(1);
    expect(loaded.experiment.systemPrompt).toBe("You are careful."); // replay metadata present
    expect(loaded.experiment.taskPrompt).toBe("Fix the bug.");
    expect(sink.markers()).toContain("BLOCK_PERSIST_RUN");
  });

  test("listRuns returns saved runs", async () => {
    const base = await tmpBase();
    const store = createStore({ logger: createLogger({ level: "silent" }), baseDir: base });
    await store.saveRun(sampleRun);
    await store.saveRun({ ...sampleRun, runId: "run-2", trace: { ...trace, runId: "run-2" } });

    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId).sort()).toEqual(["run-1", "run-2"]);
    expect(runs[0]?.model).toBe("anthropic/claude-opus-4-8");
  });

  test("listRuns returns empty when nothing saved", async () => {
    const store = createStore({ logger: createLogger({ level: "silent" }), baseDir: join(await tmpBase(), "empty") });
    expect(await store.listRuns()).toEqual([]);
  });

  // scenario-2 (failure)
  test("getRun on unknown id throws STORE_NOT_FOUND", async () => {
    const store = createStore({ logger: createLogger({ level: "silent" }), baseDir: await tmpBase() });
    try {
      await store.getRun("nope");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe(STORE_NOT_FOUND);
    }
  });

  // persisted-secret-absence: a clean trace stays clean on disk
  test("persisted files contain no obvious secret tokens", async () => {
    const base = await tmpBase();
    const store = createStore({ logger: createLogger({ level: "silent" }), baseDir: base });
    await store.saveRun(sampleRun);

    const meta = await readFile(join(base, "run-1", "run.json"), "utf8");
    const traceFile = await readFile(join(base, "run-1", "trace.json"), "utf8");
    // run.json carries only experiment metadata (no env/apiKey field at all)
    expect(meta).not.toContain("apiKey");
    expect(meta).not.toContain("ANTHROPIC_API_KEY");
    expect(traceFile).not.toContain("apiKey");
  });
});
