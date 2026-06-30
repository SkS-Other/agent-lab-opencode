// FILE: src/store/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Persist and retrieve experiment runs and their traces as flat JSON under runs/<runId>/.
//   SCOPE: createStore -> saveRun/getRun/listRuns, StoredRun/RunSummary types, StoreError
//   DEPENDS: M-TRACE, M-LOGGER
//   LINKS: M-STORE, V-M-STORE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createStore - build a TraceStore rooted at a base directory
//   TraceStore - saveRun / getRun / listRuns
//   StoredRun - persisted run record (experiment metadata + trace), no secrets
//   RunSummary - lightweight listing entry
//   ExperimentSummary - replay-sufficient experiment metadata (no sandbox.env / secrets)
//   StoreError - typed error carrying STORE_NOT_FOUND
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-STORE: flat-JSON persistence with BLOCK_PERSIST_RUN and replay metadata.
// END_CHANGE_SUMMARY

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger/index.ts";
import type { RunStatus, RunTrace } from "../trace/index.ts";

export const STORE_NOT_FOUND = "STORE_NOT_FOUND" as const;

export class StoreError extends Error {
  constructor(
    readonly code: typeof STORE_NOT_FOUND,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Replay-sufficient experiment metadata. Deliberately excludes sandbox.env so secrets never persist. */
export interface ExperimentSummary {
  name: string;
  model: string;
  systemPrompt: string;
  taskPrompt: string;
}

export interface StoredRun {
  runId: string;
  experiment: ExperimentSummary;
  status: RunStatus;
  timings: RunTrace["timings"];
  trace: RunTrace;
  rawLog?: string;
}

export interface RunSummary {
  runId: string;
  name: string;
  model: string;
  status: RunStatus;
}

export interface TraceStore {
  saveRun(run: StoredRun): Promise<void>;
  getRun(runId: string): Promise<StoredRun>;
  listRuns(): Promise<RunSummary[]>;
}

interface StoreDeps {
  logger: Logger;
  /** Root directory for run folders. Defaults to "runs". */
  baseDir?: string;
}

// START_CONTRACT: createStore
//   PURPOSE: Build a flat-JSON TraceStore rooted at a base directory.
//   INPUTS: { deps: StoreDeps - logger and optional baseDir }
//   OUTPUTS: { TraceStore }
//   SIDE_EFFECTS: reads/writes files under baseDir when used
//   LINKS: M-STORE, V-M-STORE
// END_CONTRACT: createStore
export function createStore(deps: StoreDeps): TraceStore {
  const { logger } = deps;
  const baseDir = deps.baseDir ?? "runs";

  return {
    // START_CONTRACT: saveRun
    //   PURPOSE: Persist a run as runs/<runId>/{run.json, trace.json, raw.log}.
    //   INPUTS: { run: StoredRun }
    //   OUTPUTS: { Promise<void> }
    //   SIDE_EFFECTS: creates the run directory and writes files
    //   LINKS: M-STORE, V-M-STORE
    // END_CONTRACT: saveRun
    async saveRun(run: StoredRun): Promise<void> {
      // START_BLOCK_PERSIST_RUN
      const dir = join(baseDir, run.runId);
      await mkdir(dir, { recursive: true });

      const meta = { runId: run.runId, experiment: run.experiment, status: run.status, timings: run.timings };
      await writeFile(join(dir, "run.json"), JSON.stringify(meta, null, 2), "utf8");
      await writeFile(join(dir, "trace.json"), JSON.stringify(run.trace, null, 2), "utf8");
      if (run.rawLog !== undefined) await writeFile(join(dir, "raw.log"), run.rawLog, "utf8");

      logger.info(
        { marker: "BLOCK_PERSIST_RUN", runId: run.runId, status: run.status },
        "[TraceStore][saveRun][BLOCK_PERSIST_RUN] persisted run",
      );
      // END_BLOCK_PERSIST_RUN
    },

    async getRun(runId: string): Promise<StoredRun> {
      const dir = join(baseDir, runId);
      let metaRaw: string;
      let traceRaw: string;
      try {
        [metaRaw, traceRaw] = await Promise.all([
          readFile(join(dir, "run.json"), "utf8"),
          readFile(join(dir, "trace.json"), "utf8"),
        ]);
      } catch {
        throw new StoreError(STORE_NOT_FOUND, `run "${runId}" not found`);
      }
      const meta = JSON.parse(metaRaw) as Omit<StoredRun, "trace" | "rawLog">;
      const trace = JSON.parse(traceRaw) as RunTrace;
      const rawLog = await readFile(join(dir, "raw.log"), "utf8").catch(() => undefined);
      return { ...meta, trace, ...(rawLog !== undefined ? { rawLog } : {}) };
    },

    async listRuns(): Promise<RunSummary[]> {
      let entries: string[];
      try {
        entries = await readdir(baseDir);
      } catch {
        return []; // base dir not created yet => no runs
      }
      const summaries: RunSummary[] = [];
      for (const runId of entries.sort()) {
        const metaRaw = await readFile(join(baseDir, runId, "run.json"), "utf8").catch(() => undefined);
        if (metaRaw === undefined) continue; // skip non-run directories
        const meta = JSON.parse(metaRaw) as Omit<StoredRun, "trace" | "rawLog">;
        summaries.push({ runId: meta.runId, name: meta.experiment.name, model: meta.experiment.model, status: meta.status });
      }
      return summaries;
    },
  };
}
