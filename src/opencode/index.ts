// FILE: src/opencode/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Drive OpenCode inside a sandbox and fold its session events into a normalized RunTrace via M-TRACE.
//   SCOPE: runOpenCode, OpenCodeDriver/OpenCodeSession ports, timeout handling, createSdkDriver (live), OpenCodeError
//   DEPENDS: M-SANDBOX, M-TRACE, M-LOGGER
//   LINKS: M-OPENCODE, V-M-OPENCODE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   runOpenCode - run one OpenCode session under a deadline and return its RunTrace
//   OpenCodeDriver - injectable port: start a session (faked in tests)
//   OpenCodeSession - injectable port: stream events for a task prompt
//   createSdkDriver - real driver backed by @opencode-ai/sdk (live wiring is phase-level)
//   RunOpenCodeInput - run-scoped inputs (no M-CONFIG coupling)
//   OpenCodeError - typed error (OPENCODE_START_FAILED | OPENCODE_RUN_TIMEOUT)
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-OPENCODE: driver port, deadline/partial handling, normalization via M-TRACE.
// END_CHANGE_SUMMARY

import type { Logger } from "../logger/index.ts";
import type { SandboxHandle } from "../sandbox/index.ts";
import { normalizeEvents, type RawEvent, type RunStatus, type RunTrace } from "../trace/index.ts";

export const OPENCODE_START_FAILED = "OPENCODE_START_FAILED" as const;
export const OPENCODE_RUN_TIMEOUT = "OPENCODE_RUN_TIMEOUT" as const;

export class OpenCodeError extends Error {
  constructor(
    readonly code: typeof OPENCODE_START_FAILED | typeof OPENCODE_RUN_TIMEOUT,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpenCodeError";
  }
}

export interface OpenCodeStartInput {
  sandbox: SandboxHandle;
  systemPrompt: string;
  model: string;
}

/** A live session bound to a configured agent. */
export interface OpenCodeSession {
  /**
   * Send the task prompt and stream events. Each event is pushed onto `sink` as it arrives,
   * so a caller that aborts mid-run can still read the steps captured before the deadline.
   * Resolves with the final output once the agent finishes.
   */
  stream(
    taskPrompt: string,
    sink: RawEvent[],
    signal: AbortSignal,
  ): Promise<{ finalOutputText: string; gitDiff?: string }>;
  close(): Promise<void>;
}

/** Injectable port. The real implementation wraps @opencode-ai/sdk; tests pass a fake. */
export interface OpenCodeDriver {
  start(input: OpenCodeStartInput): Promise<OpenCodeSession>;
}

export interface RunOpenCodeInput {
  runId: string;
  experimentName: string;
  sandbox: SandboxHandle;
  systemPrompt: string;
  model: string;
  taskPrompt: string;
  /** Hard wall-clock deadline for the run. */
  timeoutMs: number;
}

export interface RunOpenCodeDeps {
  logger: Logger;
  driver?: OpenCodeDriver;
  /** Clock injection for deterministic timings in tests. */
  now?: () => number;
}

// START_CONTRACT: runOpenCode
//   PURPOSE: Configure and run one OpenCode session under a deadline, returning a normalized RunTrace.
//   INPUTS: { input: RunOpenCodeInput, deps: RunOpenCodeDeps }
//   OUTPUTS: { Promise<RunTrace> - success, error, or partial-but-marked timeout trace }
//   SIDE_EFFECTS: starts/stops an OpenCode session in the sandbox; logs BLOCK_STREAM_TRACE
//   LINKS: M-OPENCODE, V-M-OPENCODE, OPENCODE_START_FAILED, OPENCODE_RUN_TIMEOUT
// END_CONTRACT: runOpenCode
export async function runOpenCode(input: RunOpenCodeInput, deps: RunOpenCodeDeps): Promise<RunTrace> {
  const { logger } = deps;
  const driver = deps.driver ?? createSdkDriver();
  const now = deps.now ?? (() => Date.now());

  const startedAtMs = now();

  // Start first. On start failure we throw before emitting BLOCK_STREAM_TRACE (V-M-OPENCODE assertion-2).
  let session: OpenCodeSession;
  try {
    session = await driver.start({ sandbox: input.sandbox, systemPrompt: input.systemPrompt, model: input.model });
  } catch (err) {
    logger.error({ runId: input.runId }, "[OpenCodeAdapter][runOpenCode] start failed");
    throw new OpenCodeError(OPENCODE_START_FAILED, "failed to start OpenCode session", err);
  }

  // START_BLOCK_STREAM_TRACE
  logger.info(
    { marker: "BLOCK_STREAM_TRACE", runId: input.runId },
    "[OpenCodeAdapter][runOpenCode][BLOCK_STREAM_TRACE] streaming session",
  );

  const sink: RawEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  let status: RunStatus = "success";
  let partial = false;
  let errorMsg: string | undefined;
  let finalOutputText = "";
  let gitDiff: string | undefined;

  try {
    const final = await session.stream(input.taskPrompt, sink, controller.signal);
    finalOutputText = final.finalOutputText;
    gitDiff = final.gitDiff;
  } catch (err) {
    if (controller.signal.aborted) {
      status = "timeout";
      partial = true;
      errorMsg = OPENCODE_RUN_TIMEOUT;
      logger.warn({ runId: input.runId }, "[OpenCodeAdapter][runOpenCode][BLOCK_STREAM_TRACE] run timed out");
    } else {
      status = "error";
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
    await safeClose(session, logger, input.runId);
  }
  // END_BLOCK_STREAM_TRACE

  const endedAtMs = now();
  return normalizeEvents(
    {
      runId: input.runId,
      experiment: { name: input.experimentName, model: input.model },
      startedAtMs,
      endedAtMs,
      status,
      finalOutputText,
      ...(gitDiff !== undefined ? { gitDiff } : {}),
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      partial,
    },
    sink,
    logger,
  );
}

// START_CONTRACT: createSdkDriver
//   PURPOSE: Build the live OpenCodeDriver backed by @opencode-ai/sdk.
//   INPUTS: {}
//   OUTPUTS: { OpenCodeDriver }
//   SIDE_EFFECTS: starts opencode serve and connects the SDK client when used
//   LINKS: M-OPENCODE
// END_CONTRACT: createSdkDriver
export function createSdkDriver(): OpenCodeDriver {
  return {
    async start(): Promise<OpenCodeSession> {
      // The SDK surface (opencode serve + @opencode-ai/sdk session/prompt/SSE) is wired and
      // verified against a real container during the Phase-2 gated live run, not on faked
      // module-level evidence. Per replan policy, do not improvise the SDK shape here.
      throw new OpenCodeError(
        OPENCODE_START_FAILED,
        "live SDK driver not wired yet; supply a driver via deps or complete phase-level integration",
      );
    },
  };
}

// --- private helpers ---

async function safeClose(session: OpenCodeSession, logger: Logger, runId: string): Promise<void> {
  try {
    await session.close();
  } catch {
    logger.warn({ runId }, "[OpenCodeAdapter][runOpenCode] session close failed (ignored)");
  }
}
