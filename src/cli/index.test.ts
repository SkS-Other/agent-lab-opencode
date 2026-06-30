// FILE: src/cli/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-CLI dispatch, parseable JSON output, exit codes, replay, and CLI_BAD_USAGE handling.
//   SCOPE: run/list/show/compare happy paths, bad usage exit codes, BLOCK_DISPATCH_COMMAND marker
//   DEPENDS: M-CLI, M-ENGINE, M-STORE, M-LOGGER
//   LINKS: V-M-CLI
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   memStore - in-memory TraceStore fake with a seeded run
//   capture - stdout/stderr line collector
//   parseOut - parse the single JSON line written to stdout
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-CLI tests (commands, exit codes, replay, bad usage).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger/index.ts";
import type { StoredRun, TraceStore } from "../store/index.ts";
import type { RunTrace } from "../trace/index.ts";
import { CLI_BAD_USAGE, EXIT_BAD_USAGE, EXIT_OK, main } from "./index.ts";

function trace(runId: string, toolSeq: string[] = ["edit"]): RunTrace {
  return {
    runId,
    experiment: { name: "exp", model: "a/b" },
    status: "success",
    partial: false,
    timings: { startedAtMs: 0, endedAtMs: 1, durationMs: 1 },
    steps: toolSeq.map((t) => ({ kind: "tool_call" as const, tool: t, ok: true })),
    tokenUsage: { input: 1, output: 1, total: 2 },
    finalOutput: { text: "done" },
  };
}

function storedRun(runId: string, toolSeq?: string[]): StoredRun {
  return {
    runId,
    experiment: { name: "exp", model: "anthropic/claude-opus-4-8", systemPrompt: "sp", taskPrompt: "tp" },
    status: "success",
    timings: trace(runId).timings,
    trace: trace(runId, toolSeq),
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

function capture() {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { out: (s: string) => outLines.push(s), err: (s: string) => errLines.push(s), outLines, errLines };
}

function parseOut(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

const silent = createLogger({ level: "silent" });

describe("main", () => {
  // run: dispatches to the engine and emits parseable JSON with exit 0
  test("run dispatches to the injected engine and prints results", async () => {
    const io = capture();
    const fakeRun = (async () => [{ runId: "run-1", name: "x", status: "success" as const }]) as never;

    const code = await main(["run", "--system", "sp", "--model", "a/b", "--task", "tp"], {
      logger: silent,
      store: memStore(),
      out: io.out,
      run: fakeRun,
    });

    expect(code).toBe(EXIT_OK);
    const payload = parseOut(io.outLines[0]);
    expect(payload.command).toBe("run");
    expect(Array.isArray(payload.results)).toBe(true);
  });

  // run --from replays a stored definition
  test("run --from replays a stored experiment", async () => {
    const io = capture();
    let received: unknown;
    const fakeRun = (async (input: unknown) => {
      received = input;
      return [{ runId: "run-2", name: "exp", status: "success" as const }];
    }) as never;

    const code = await main(["run", "--from", "run-1"], {
      logger: silent,
      store: memStore([storedRun("run-1")]),
      out: io.out,
      run: fakeRun,
    });

    expect(code).toBe(EXIT_OK);
    expect((received as { taskPrompt?: string }).taskPrompt).toBe("tp"); // replayed from store
  });

  test("list prints known runs as JSON", async () => {
    const io = capture();
    const code = await main(["list"], { logger: silent, store: memStore([storedRun("run-1")]), out: io.out });
    expect(code).toBe(EXIT_OK);
    const payload = parseOut(io.outLines[0]);
    expect(payload.command).toBe("list");
    expect((payload.runs as unknown[])).toHaveLength(1);
  });

  test("show prints one run", async () => {
    const io = capture();
    const code = await main(["show", "run-1"], { logger: silent, store: memStore([storedRun("run-1")]), out: io.out });
    expect(code).toBe(EXIT_OK);
    expect((parseOut(io.outLines[0]).run as { runId: string }).runId).toBe("run-1");
  });

  test("compare diffs runs via the injected comparator", async () => {
    const io = capture();
    const code = await main(["compare", "run-1", "run-2"], {
      logger: silent,
      store: memStore([storedRun("run-1", ["edit"]), storedRun("run-2", ["bash", "edit"])]),
      out: io.out,
    });
    expect(code).toBe(EXIT_OK);
    const payload = parseOut(io.outLines[0]);
    expect(payload.command).toBe("compare");
    expect(payload.baselineRunId).toBe("run-1");
  });

  // bad usage: unknown command
  test("unknown command exits with CLI_BAD_USAGE", async () => {
    const io = capture();
    const code = await main(["frobnicate"], { logger: silent, store: memStore(), out: io.out, err: io.err });
    expect(code).toBe(EXIT_BAD_USAGE);
    expect(parseOut(io.errLines[0]).error).toBe(CLI_BAD_USAGE);
  });

  test("show without a runId exits with bad usage", async () => {
    const io = capture();
    const code = await main(["show"], { logger: silent, store: memStore(), out: io.out, err: io.err });
    expect(code).toBe(EXIT_BAD_USAGE);
  });

  test("invalid run input (missing --task) exits with bad usage", async () => {
    const io = capture();
    const code = await main(["run", "--system", "sp", "--model", "a/b"], {
      logger: silent,
      store: memStore(),
      out: io.out,
      err: io.err,
      run: (async () => []) as never,
    });
    expect(code).toBe(EXIT_BAD_USAGE);
  });

  test("no command prints usage and exits bad usage", async () => {
    const io = capture();
    const code = await main([], { logger: silent, store: memStore(), out: io.out });
    expect(code).toBe(EXIT_BAD_USAGE);
  });

  // required marker
  test("emits BLOCK_DISPATCH_COMMAND", async () => {
    const objects: Array<Record<string, unknown>> = [];
    const logger = createLogger({ level: "debug", destination: { write: (s: string) => { for (const l of s.split("\n")) if (l.trim()) objects.push(JSON.parse(l)); } } });
    await main(["list"], { logger, store: memStore(), out: () => {} });
    expect(objects.some((o) => o.marker === "BLOCK_DISPATCH_COMMAND")).toBe(true);
  });
});
