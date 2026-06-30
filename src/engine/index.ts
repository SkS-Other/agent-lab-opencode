// FILE: src/engine/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Orchestrate experiments end to end with bounded parallelism, guaranteed cleanup, and a comparison facade.
//   SCOPE: runExperiment, compareRuns, RunExecutor port, createDefaultExecutor, bounded pool, RunResult/CompareResult
//   DEPENDS: M-CONFIG, M-SANDBOX, M-OPENCODE, M-STORE, M-TRACE, M-LOGGER
//   LINKS: M-ENGINE, V-M-ENGINE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   runExperiment - run one or many experiments with bounded concurrency; persist each
//   compareRuns - load runs via M-STORE and diff them via M-TRACE (baseline = first)
//   createDefaultExecutor - wire withSandbox + runOpenCode into a RunExecutor with guaranteed teardown
//   RunExecutor - injectable port that turns one definition into a RunTrace (faked in tests)
//   RunResult - per-run outcome { runId, name, status, error? }
//   CompareResult - baseline runId + per-run TraceDiff list
//   RunExperimentDeps - { logger, store, executor?, concurrency?, idGen? }
//   DEFAULT_CONCURRENCY - default parallelism (4)
//   EngineError - typed error carrying ENGINE_RUN_FAILED
//   ENGINE_RUN_FAILED - stable error code constant
//   createStore - re-exported from M-STORE so callers build a store without importing it directly
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-ENGINE: bounded-concurrency orchestration, isolation, compare facade.
// END_CHANGE_SUMMARY

import type { ExperimentDefinition } from "../config/index.ts";
import type { Logger } from "../logger/index.ts";
import { runOpenCode, type OpenCodeDriver } from "../opencode/index.ts";
import { withSandbox, type DockerEngine, type SandboxSpec } from "../sandbox/index.ts";
import { createStore, type StoredRun, type TraceStore } from "../store/index.ts";
import { diffTraces, type RunStatus, type RunTrace, type TraceDiff } from "../trace/index.ts";

export const ENGINE_RUN_FAILED = "ENGINE_RUN_FAILED" as const;
export const DEFAULT_CONCURRENCY = 4;

export class EngineError extends Error {
  constructor(
    readonly code: typeof ENGINE_RUN_FAILED,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface RunResult {
  runId: string;
  name: string;
  status: RunStatus | "start_failed";
  error?: string;
}

export interface CompareResult {
  baselineRunId: string;
  diffs: Array<{ runId: string; diff: TraceDiff }>;
}

/** Injectable port: turn one definition into a RunTrace. Default wires sandbox + opencode. */
export interface RunExecutor {
  execute(input: { runId: string; experiment: ExperimentDefinition }): Promise<RunTrace>;
}

export interface RunExperimentDeps {
  logger: Logger;
  store: TraceStore;
  executor?: RunExecutor;
  concurrency?: number;
  idGen?: () => string;
}

// START_CONTRACT: runExperiment
//   PURPOSE: Run one or many experiments with bounded concurrency, persist each, and isolate failures.
//   INPUTS: { experiments: ExperimentDefinition | ExperimentDefinition[], deps: RunExperimentDeps }
//   OUTPUTS: { Promise<RunResult[]> - one terminal result per experiment, order preserved }
//   SIDE_EFFECTS: provisions sandboxes, runs OpenCode, persists runs via the store
//   LINKS: M-ENGINE, V-M-ENGINE
// END_CONTRACT: runExperiment
export async function runExperiment(
  experiments: ExperimentDefinition | ExperimentDefinition[],
  deps: RunExperimentDeps,
): Promise<RunResult[]> {
  const { logger, store } = deps;
  const list = Array.isArray(experiments) ? experiments : [experiments];
  const executor = deps.executor ?? createDefaultExecutor({ logger });
  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);

  // START_BLOCK_SCHEDULE_RUNS
  logger.info(
    { marker: "BLOCK_SCHEDULE_RUNS", total: list.length, concurrency },
    "[ExperimentEngine][runExperiment][BLOCK_SCHEDULE_RUNS] scheduling runs",
  );

  return runPool(list, concurrency, async (experiment) => {
    const runId = idGen();
    try {
      const trace = await executor.execute({ runId, experiment });
      const record: StoredRun = {
        runId,
        experiment: {
          name: experiment.name,
          model: experiment.model,
          systemPrompt: experiment.systemPrompt,
          taskPrompt: experiment.taskPrompt,
        },
        status: trace.status,
        timings: trace.timings,
        trace,
      };
      // Persist with the real terminal status; never success for a non-success run (V-M-ENGINE assertion-4).
      await store.saveRun(record);
      return { runId, name: experiment.name, status: trace.status };
    } catch (err) {
      // A single run's failure is isolated; siblings keep going (assertion-3). Not persisted as success.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ runId, name: experiment.name }, "[ExperimentEngine][runExperiment] run failed to execute");
      return { runId, name: experiment.name, status: "start_failed", error: message };
    }
  });
  // END_BLOCK_SCHEDULE_RUNS
}

// START_CONTRACT: compareRuns
//   PURPOSE: Load completed runs and diff each against the first (baseline) via M-TRACE.
//   INPUTS: { runIds: string[], deps: { logger: Logger; store: TraceStore } }
//   OUTPUTS: { Promise<CompareResult> }
//   SIDE_EFFECTS: reads persisted runs
//   LINKS: M-ENGINE, V-M-ENGINE, M-TRACE
// END_CONTRACT: compareRuns
export async function compareRuns(
  runIds: string[],
  deps: { logger: Logger; store: TraceStore },
): Promise<CompareResult> {
  if (runIds.length < 2) {
    throw new EngineError(ENGINE_RUN_FAILED, "compareRuns needs at least two run ids");
  }
  const [baselineId, ...rest] = runIds as [string, ...string[]];
  const baseline = await deps.store.getRun(baselineId);
  const diffs: CompareResult["diffs"] = [];
  for (const id of rest) {
    const other = await deps.store.getRun(id);
    diffs.push({ runId: id, diff: diffTraces(baseline.trace, other.trace, deps.logger) });
  }
  return { baselineRunId: baselineId, diffs };
}

// START_CONTRACT: createDefaultExecutor
//   PURPOSE: Build a RunExecutor that provisions a sandbox and drives OpenCode, with guaranteed teardown.
//   INPUTS: { deps: { logger: Logger; driver?: OpenCodeDriver; engine?: DockerEngine } }
//   OUTPUTS: { RunExecutor }
//   SIDE_EFFECTS: provisions/disposes a sandbox per run when used
//   LINKS: M-ENGINE, M-SANDBOX, M-OPENCODE
// END_CONTRACT: createDefaultExecutor
export function createDefaultExecutor(deps: {
  logger: Logger;
  driver?: OpenCodeDriver;
  engine?: DockerEngine;
}): RunExecutor {
  return {
    async execute({ runId, experiment }): Promise<RunTrace> {
      const spec: SandboxSpec = {
        image: experiment.sandbox.image,
        networkAllowlist: experiment.sandbox.networkAllowlist,
        env: collectProviderEnv(),
        ...(experiment.sandbox.resourceLimits !== undefined ? { resourceLimits: experiment.sandbox.resourceLimits } : {}),
      };
      const sandboxDeps = { logger: deps.logger, ...(deps.engine !== undefined ? { engine: deps.engine } : {}) };
      return withSandbox(spec, sandboxDeps, (handle) =>
        runOpenCode(
          {
            runId,
            experimentName: experiment.name,
            sandbox: handle,
            systemPrompt: experiment.systemPrompt,
            model: experiment.model,
            taskPrompt: experiment.taskPrompt,
            timeoutMs: experiment.sandbox.timeoutMs,
          },
          { logger: deps.logger, ...(deps.driver !== undefined ? { driver: deps.driver } : {}) },
        ),
      );
    },
  };
}

// --- private helpers ---

/** Bounded worker pool: at most `limit` runs in flight, results in input order. */
async function runPool<I, O>(items: I[], limit: number, worker: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Collect known provider keys from the environment for env-injection into the sandbox. */
function collectProviderEnv(): Record<string, string> {
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY"];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Re-export createStore so callers can build the default store without importing M-STORE directly. */
export { createStore };
