// FILE: src/opencode/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-OPENCODE run success, start-failure (no stream marker), and timeout->partial trace on a fake driver.
//   SCOPE: runOpenCode success, OPENCODE_START_FAILED, OPENCODE_RUN_TIMEOUT partial, BLOCK_STREAM_TRACE marker
//   DEPENDS: M-OPENCODE, M-SANDBOX, M-LOGGER
//   LINKS: V-M-OPENCODE
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   collectLines - in-memory pino destination capturing markers
//   fakeSandbox - minimal SandboxHandle stub
//   makeDriver - OpenCodeDriver fake with scriptable behavior
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-OPENCODE tests (success, start-fail, timeout-partial, error).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger/index.ts";
import type { SandboxHandle } from "../sandbox/index.ts";
import {
  createSdkDriver,
  OPENCODE_RUN_TIMEOUT,
  OPENCODE_START_FAILED,
  OpenCodeError,
  runOpenCode,
  type OpenCodeDriver,
  type RunOpenCodeInput,
} from "./index.ts";
import type { RawEvent } from "../trace/index.ts";

function collectLines() {
  const objects: Array<Record<string, unknown>> = [];
  const dest = {
    write(s: string) {
      for (const line of s.split("\n")) if (line.trim()) objects.push(JSON.parse(line));
    },
  };
  return { dest, markers: () => objects.map((o) => o.marker).filter(Boolean) as string[] };
}

const fakeSandbox: SandboxHandle = {
  sandboxId: "sbx-test",
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async dispose() {},
};

function baseInput(overrides: Partial<RunOpenCodeInput> = {}): RunOpenCodeInput {
  return {
    runId: "run-1",
    experimentName: "exp-a",
    sandbox: fakeSandbox,
    systemPrompt: "You are careful.",
    model: "anthropic/claude-opus-4-8",
    taskPrompt: "Fix the bug.",
    timeoutMs: 1000,
    ...overrides,
  };
}

const sampleEvents: RawEvent[] = [
  { type: "message", role: "assistant", text: "working", tokens: { input: 5, output: 2 } },
  { type: "tool_call", tool: "edit", ok: true },
];

/** Driver fake: emits scripted events into the sink, then resolves/aborts/throws per options. */
function makeDriver(opts: {
  failStart?: boolean;
  emit?: RawEvent[];
  finalText?: string;
  hangUntilAbort?: boolean;
  throwMid?: boolean;
}): OpenCodeDriver {
  return {
    async start() {
      if (opts.failStart) throw new Error("serve crashed");
      return {
        async stream(_taskPrompt: string, sink: RawEvent[], signal: AbortSignal) {
          for (const ev of opts.emit ?? []) sink.push(ev);
          if (opts.throwMid) throw new Error("stream error");
          if (opts.hangUntilAbort) {
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) return reject(new Error("aborted"));
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
          }
          return { finalOutputText: opts.finalText ?? "done", gitDiff: "diff" };
        },
        async close() {},
      };
    },
  };
}

describe("runOpenCode", () => {
  let tick = 0;
  const now = () => (tick += 1000); // deterministic monotonic clock

  // scenario-1 (success)
  test("streams events into a complete RunTrace and emits BLOCK_STREAM_TRACE", async () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, level: "debug" });
    const driver = makeDriver({ emit: sampleEvents, finalText: "all green" });

    const trace = await runOpenCode(baseInput(), { logger, driver, now });
    expect(trace.steps).toHaveLength(2);
    expect(trace.status).toBe("success");
    expect(trace.partial).toBe(false);
    expect(trace.finalOutput.text).toBe("all green");
    expect(trace.tokenUsage.total).toBe(7);
    expect(sink.markers()).toContain("BLOCK_STREAM_TRACE");
  });

  // scenario-2 (failure): start fails, no BLOCK_STREAM_TRACE
  test("throws OPENCODE_START_FAILED and does NOT emit BLOCK_STREAM_TRACE", async () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, level: "debug" });
    const driver = makeDriver({ failStart: true });

    await expect(runOpenCode(baseInput(), { logger, driver, now })).rejects.toMatchObject({
      code: OPENCODE_START_FAILED,
    });
    expect(sink.markers()).not.toContain("BLOCK_STREAM_TRACE");
  });

  // timeout -> partial trace carrying steps captured before the deadline
  test("marks a timed-out run partial and keeps pre-deadline steps", async () => {
    const logger = createLogger({ level: "silent" });
    const driver = makeDriver({ emit: sampleEvents, hangUntilAbort: true });

    const trace = await runOpenCode(baseInput({ timeoutMs: 20 }), { logger, driver, now });
    expect(trace.status).toBe("timeout");
    expect(trace.partial).toBe(true);
    expect(trace.error).toBe(OPENCODE_RUN_TIMEOUT);
    expect(trace.steps).toHaveLength(2); // steps captured before abort survive
  });

  // non-timeout mid-stream error -> error status
  test("records a mid-stream error as status=error", async () => {
    const logger = createLogger({ level: "silent" });
    const driver = makeDriver({ emit: [sampleEvents[0]!], throwMid: true });

    const trace = await runOpenCode(baseInput(), { logger, driver, now });
    expect(trace.status).toBe("error");
    expect(trace.steps).toHaveLength(1);
    expect(trace.error).toBe("stream error");
  });
});

describe("createSdkDriver", () => {
  // The live driver is intentionally not wired at module level (phase-level integration).
  test("start() reports unwired live driver via OPENCODE_START_FAILED", async () => {
    const driver = createSdkDriver();
    await expect(
      driver.start({ sandbox: fakeSandbox, systemPrompt: "x", model: "a/b" }),
    ).rejects.toBeInstanceOf(OpenCodeError);
  });
});
