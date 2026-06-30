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
//   OpenCodeStartInput - input to OpenCodeDriver.start (sandbox, systemPrompt, model)
//   createSdkDriver - real driver backed by @opencode-ai/sdk (live wiring is phase-level)
//   RunOpenCodeInput - run-scoped inputs (no M-CONFIG coupling)
//   RunOpenCodeDeps - { logger, driver?, now? } for runOpenCode
//   OpenCodeError - typed error (OPENCODE_START_FAILED | OPENCODE_RUN_TIMEOUT)
//   OPENCODE_START_FAILED - stable error code constant
//   OPENCODE_RUN_TIMEOUT - stable error code constant
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.1.0 - Wire createSdkDriver to @opencode-ai/sdk (session.create/prompt/diff, part normalization).
//   LAST_CHANGE: v1.0.0 - Initial M-OPENCODE: driver port, deadline/partial handling, normalization via M-TRACE.
// END_CHANGE_SUMMARY

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
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
export function createSdkDriver(opts: { connect?: (baseUrl: string) => OpencodeClient } = {}): OpenCodeDriver {
  const connect = opts.connect ?? ((baseUrl: string) => createOpencodeClient({ baseUrl }));
  return {
    async start(input: OpenCodeStartInput): Promise<OpenCodeSession> {
      const endpoint = input.sandbox.endpoint;
      if (endpoint === undefined) {
        throw new OpenCodeError(OPENCODE_START_FAILED, "sandbox has no published endpoint for opencode serve");
      }
      const client = connect(endpoint);
      const created = await client.session.create({ body: { title: "agent-lab" } });
      const sessionId = (created.data as { id?: string } | undefined)?.id;
      if (sessionId === undefined) {
        throw new OpenCodeError(OPENCODE_START_FAILED, "opencode session.create returned no id", created.error);
      }
      const { providerID, modelID } = splitModel(input.model);

      return {
        async stream(taskPrompt, sink, signal) {
          const res = await client.session.prompt({
            path: { id: sessionId },
            body: {
              model: { providerID, modelID },
              system: input.systemPrompt,
              parts: [{ type: "text", text: taskPrompt }],
            },
            signal,
          });
          if (res.error !== undefined || res.data === undefined) {
            throw new Error(`opencode prompt failed: ${JSON.stringify(res.error ?? "no data")}`);
          }
          const { info, parts } = res.data as { info?: { tokens?: { input: number; output: number } }; parts: unknown[] };

          const events = partsToEvents(parts);
          const firstMessage = events.find((e): e is Extract<RawEvent, { type: "message" }> => e.type === "message");
          if (firstMessage !== undefined && info?.tokens !== undefined) {
            firstMessage.tokens = { input: info.tokens.input, output: info.tokens.output };
          }
          for (const ev of events) sink.push(ev);

          const finalOutputText = events
            .filter((e): e is Extract<RawEvent, { type: "message" }> => e.type === "message" && e.role === "assistant")
            .map((e) => e.text)
            .join("\n");
          const gitDiff = await collectDiff(client, sessionId);
          return { finalOutputText, ...(gitDiff !== undefined ? { gitDiff } : {}) };
        },
        async close() {
          await client.session.abort({ path: { id: sessionId } }).catch(() => {});
        },
      };
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

/** Split a "provider/model" string into the SDK's { providerID, modelID } shape. */
function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new OpenCodeError(OPENCODE_START_FAILED, `model must be in provider/model form, got "${model}"`);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** Map OpenCode message parts to normalized RawEvents (text -> message, tool -> tool_call). */
function partsToEvents(parts: unknown[]): RawEvent[] {
  const events: RawEvent[] = [];
  for (const raw of parts) {
    const part = raw as { type?: string; text?: string; synthetic?: boolean; tool?: string; state?: { status?: string } };
    if (part.type === "text" && part.synthetic !== true && typeof part.text === "string" && part.text.length > 0) {
      events.push({ type: "message", role: "assistant", text: part.text });
    } else if (part.type === "tool" && typeof part.tool === "string") {
      events.push({ type: "tool_call", tool: part.tool, ok: part.state?.status !== "error" });
    }
  }
  return events;
}

/** Fetch the session git diff, tolerating SDK/shape errors (diff is best-effort evidence). */
async function collectDiff(client: OpencodeClient, sessionId: string): Promise<string | undefined> {
  try {
    const res = await client.session.diff({ path: { id: sessionId } });
    if (res.error !== undefined || res.data === undefined) return undefined;
    const diffs = res.data as Array<{ path?: string; diff?: string }>;
    const text = diffs.map((d) => d.diff ?? "").filter((s) => s.length > 0).join("\n");
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
