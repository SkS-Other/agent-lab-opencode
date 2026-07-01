#!/usr/bin/env bun
// FILE: src/cli/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Expose the engine to agents and humans as run/list/show/compare with parseable JSON stdout and exit codes.
//   SCOPE: main dispatch, flag parsing, run/list/show/compare commands, CLI_BAD_USAGE, replay via --from
//   DEPENDS: M-ENGINE, M-CONFIG, M-LOGGER
//   LINKS: M-CLI, V-M-CLI
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   main - parse argv, dispatch a command, return an exit code
//   CliDeps - injectable ports (logger, store, engine fns, stdout/stderr sinks)
//   CliError - typed error carrying CLI_BAD_USAGE
//   CLI_BAD_USAGE - stable error code constant
//   EXIT_OK - exit code 0 (success)
//   EXIT_RUNTIME - exit code 1 (runtime error)
//   EXIT_BAD_USAGE - exit code 2 (bad usage / invalid input)
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-CLI: run/list/show/compare dispatch over the engine with JSON output.
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";
import { expandMatrix, loadExperiment, type ExperimentDefinition } from "../config/index.ts";
import { compareRuns, createStore, runExperiment } from "../engine/index.ts";
import { createLogger, type Logger } from "../logger/index.ts";
import type { TraceStore } from "../store/index.ts";

export const CLI_BAD_USAGE = "CLI_BAD_USAGE" as const;
export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_BAD_USAGE = 2;

export class CliError extends Error {
  readonly code = CLI_BAD_USAGE;
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface CliDeps {
  logger?: Logger;
  store?: TraceStore;
  out?: (line: string) => void;
  err?: (line: string) => void;
  run?: typeof runExperiment;
  compare?: typeof compareRuns;
}

// START_CONTRACT: main
//   PURPOSE: Dispatch a CLI command to the engine and emit a parseable JSON result.
//   INPUTS: { argv: string[] - args after the program name, deps?: CliDeps }
//   OUTPUTS: { Promise<number> - process exit code (0 ok, 1 runtime, 2 bad usage) }
//   SIDE_EFFECTS: writes JSON to the out sink; drives the engine/store
//   LINKS: M-CLI, V-M-CLI, CLI_BAD_USAGE
// END_CONTRACT: main
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const logger = deps.logger ?? createLogger({ level: "silent" });
  const store = deps.store ?? createStore({ logger });
  const run = deps.run ?? runExperiment;
  const compare = deps.compare ?? compareRuns;

  const [command, ...rest] = argv;

  // START_BLOCK_DISPATCH_COMMAND
  logger.info({ marker: "BLOCK_DISPATCH_COMMAND", command: command ?? "" }, "[Cli][main][BLOCK_DISPATCH_COMMAND] dispatch");
  try {
    switch (command) {
      case "run":
        return await cmdRun(rest, { logger, store, run, out });
      case "list":
        return await cmdList({ store, out });
      case "show":
        return await cmdShow(rest, { store, out });
      case "compare":
        return await cmdCompare(rest, { logger, store, compare, out });
      case undefined:
      case "help":
      case "--help":
        out(USAGE);
        return command === undefined ? EXIT_BAD_USAGE : EXIT_OK;
      default:
        throw new CliError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof CliError || (error as { code?: string })?.code === "CONFIG_INVALID_INPUT") {
      err(JSON.stringify({ error: CLI_BAD_USAGE, message: (error as Error).message }));
      return EXIT_BAD_USAGE;
    }
    err(JSON.stringify({ error: "RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error) }));
    return EXIT_RUNTIME;
  }
  // END_BLOCK_DISPATCH_COMMAND
}

const USAGE = `agent-lab <command>

Commands:
  run     --system <p> --model <m> --task <t> [--allow host,host] [--concurrency n]
  run     --config <file.json>        run a single definition or a variation matrix
  run     --from <runId>              replay a stored experiment definition
  list                                list known runs
  show    <runId>                     print one run with its trace
  compare <runId> <runId> [...]       diff runs against the first (baseline)`;

// --- command handlers ---

async function cmdRun(
  rest: string[],
  ctx: { logger: Logger; store: TraceStore; run: typeof runExperiment; out: (s: string) => void },
): Promise<number> {
  const { flags } = parseFlags(rest);
  const defs = await resolveDefinitions(flags, ctx.store);
  const input = defs.length === 1 ? defs[0]! : defs;
  const results = await ctx.run(input, {
    logger: ctx.logger,
    store: ctx.store,
    ...(flags.concurrency !== undefined ? { concurrency: positiveInt(flags.concurrency, "--concurrency") } : {}),
  });
  ctx.out(JSON.stringify({ command: "run", results }));
  return EXIT_OK;
}

async function cmdList(ctx: { store: TraceStore; out: (s: string) => void }): Promise<number> {
  const runs = await ctx.store.listRuns();
  ctx.out(JSON.stringify({ command: "list", runs }));
  return EXIT_OK;
}

async function cmdShow(rest: string[], ctx: { store: TraceStore; out: (s: string) => void }): Promise<number> {
  const { positionals } = parseFlags(rest);
  const runId = positionals[0];
  if (runId === undefined) throw new CliError("show requires a <runId>");
  const run = await ctx.store.getRun(runId);
  ctx.out(JSON.stringify({ command: "show", run }));
  return EXIT_OK;
}

async function cmdCompare(
  rest: string[],
  ctx: { logger: Logger; store: TraceStore; compare: typeof compareRuns; out: (s: string) => void },
): Promise<number> {
  const { positionals } = parseFlags(rest);
  if (positionals.length < 2) throw new CliError("compare requires at least two <runId> arguments");
  const result = await ctx.compare(positionals, { logger: ctx.logger, store: ctx.store });
  ctx.out(JSON.stringify({ command: "compare", ...result }));
  return EXIT_OK;
}

// --- private helpers ---

async function resolveDefinitions(flags: Record<string, string>, store: TraceStore): Promise<ExperimentDefinition[]> {
  if (flags.from !== undefined) {
    const prior = await store.getRun(flags.from);
    return [loadExperiment({ name: prior.experiment.name, systemPrompt: prior.experiment.systemPrompt, model: prior.experiment.model, taskPrompt: prior.experiment.taskPrompt })];
  }
  if (flags.config !== undefined) {
    const raw = JSON.parse(await readFile(flags.config, "utf8")) as Record<string, unknown>;
    return "base" in raw ? expandMatrix(raw as unknown as Parameters<typeof expandMatrix>[0]) : [loadExperiment(raw)];
  }
  return [
    loadExperiment({
      systemPrompt: flags.system,
      model: flags.model,
      taskPrompt: flags.task,
      ...(flags.allow !== undefined ? { sandbox: { networkAllowlist: flags.allow.split(",") } } : {}),
    }),
  ];
}

function parseFlags(args: string[]): { flags: Record<string, string>; positionals: string[] } {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function positiveInt(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`${label} must be a positive integer`);
  return n;
}

// Entry point when invoked directly (bun src/cli/index.ts ...).
if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
