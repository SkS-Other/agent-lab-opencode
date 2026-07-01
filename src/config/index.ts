// FILE: src/config/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Parse and validate experiment definitions and expand a variation matrix into concrete definitions.
//   SCOPE: loadExperiment, expandMatrix, ExperimentDefinition/ExperimentMatrix types, input validation, defaults
//   DEPENDS: none
//   LINKS: M-CONFIG, V-M-CONFIG
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   loadExperiment - parse and validate one experiment definition (throws ConfigError on bad input)
//   expandMatrix - expand a variation matrix into a list of validated experiment definitions
//   ExperimentDefinition - validated experiment input shape
//   ExperimentMatrix - variation-matrix input shape
//   SandboxOptions - sandbox/network options for one run
//   NetworkMode - 'open' | 'vacuum'
//   SandboxBackend - 'docker' | 'microsandbox'
//   ConfigError - typed validation error carrying code CONFIG_INVALID_INPUT
//   CONFIG_INVALID_INPUT - stable error code constant
//   GraceLogger - minimal structural logger interface (DI; keeps DEPENDS=none)
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-CONFIG: validation, defaults, matrix expansion with BLOCK markers.
// END_CHANGE_SUMMARY

/** Minimal structural logger; pino.Logger satisfies it. Optional so M-CONFIG keeps DEPENDS=none. */
export interface GraceLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Stable error code for invalid configuration input. */
export const CONFIG_INVALID_INPUT = "CONFIG_INVALID_INPUT" as const;

export class ConfigError extends Error {
  readonly code = CONFIG_INVALID_INPUT;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type NetworkMode = "open" | "vacuum";
export type SandboxBackend = "docker" | "microsandbox";

export interface SandboxOptions {
  /** Container image that hosts opencode. */
  image: string;
  /** Isolation backend: 'docker' (default) or 'microsandbox' (libkrun microVM). */
  backend?: SandboxBackend;
  /** Hosts the sandbox may reach (deny-by-default otherwise); the LLM endpoint goes here. */
  networkAllowlist: string[];
  /** Hard wall-clock timeout for the run, in milliseconds. */
  timeoutMs: number;
  /** 'open' (default) bridge egress, or 'vacuum' strict deny-by-default egress allowlist. */
  networkMode?: NetworkMode;
  /** Optional resource caps. */
  resourceLimits?: { cpus?: number; memoryMb?: number };
}

export interface ExperimentDefinition {
  /** Human/agent-facing label, unique enough to tell variations apart. */
  name: string;
  /** System prompt under test. */
  systemPrompt: string;
  /** Model string in provider/model form. */
  model: string;
  /** The task prompt sent to the agent. */
  taskPrompt: string;
  /** Sandbox/network options. */
  sandbox: SandboxOptions;
}

export interface ExperimentMatrix {
  base: {
    name?: string;
    systemPrompt: string;
    model: string;
    taskPrompt: string;
    sandbox?: Partial<SandboxOptions>;
  };
  /** Axes to vary; the cartesian product over present axes is expanded. */
  variations?: {
    systemPrompt?: string[];
    model?: string[];
    taskPrompt?: string[];
  };
  concurrency?: number;
}

const DEFAULT_SANDBOX: SandboxOptions = {
  image: "agent-lab-opencode:latest",
  networkAllowlist: [],
  timeoutMs: 300_000,
};

// START_CONTRACT: loadExperiment
//   PURPOSE: Parse and validate a single raw experiment definition into a typed ExperimentDefinition.
//   INPUTS: { raw: unknown - candidate definition, logger?: GraceLogger }
//   OUTPUTS: { ExperimentDefinition - fully validated and defaulted }
//   SIDE_EFFECTS: none (pure; only optional logging)
//   LINKS: M-CONFIG, V-M-CONFIG, CONFIG_INVALID_INPUT
// END_CONTRACT: loadExperiment
export function loadExperiment(raw: unknown, logger?: GraceLogger): ExperimentDefinition {
  // START_BLOCK_VALIDATE_INPUT
  logger?.debug({ marker: "BLOCK_VALIDATE_INPUT" }, "[Config][loadExperiment][BLOCK_VALIDATE_INPUT] validating");

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("experiment definition must be an object");
  }
  const input = raw as Record<string, unknown>;

  const systemPrompt = requireString(input, "systemPrompt");
  const model = requireString(input, "model");
  const taskPrompt = requireString(input, "taskPrompt");
  const name = optionalString(input, "name") ?? defaultName(model);
  const sandbox = normalizeSandbox(input.sandbox);

  // Build the result only after every field validated — never return a partial object.
  return { name, systemPrompt, model, taskPrompt, sandbox };
  // END_BLOCK_VALIDATE_INPUT
}

// START_CONTRACT: expandMatrix
//   PURPOSE: Expand a variation matrix into the cartesian product of validated experiment definitions.
//   INPUTS: { matrix: ExperimentMatrix, logger?: GraceLogger }
//   OUTPUTS: { ExperimentDefinition[] - one per variation combination }
//   SIDE_EFFECTS: none (pure; only optional logging)
//   LINKS: M-CONFIG, V-M-CONFIG
// END_CONTRACT: expandMatrix
export function expandMatrix(matrix: ExperimentMatrix, logger?: GraceLogger): ExperimentDefinition[] {
  // START_BLOCK_EXPAND_MATRIX
  if (typeof matrix !== "object" || matrix === null || typeof matrix.base !== "object" || matrix.base === null) {
    throw new ConfigError("matrix must have a base object");
  }

  const systemPrompts = nonEmptyAxis(matrix.variations?.systemPrompt, matrix.base.systemPrompt);
  const models = nonEmptyAxis(matrix.variations?.model, matrix.base.model);
  const taskPrompts = nonEmptyAxis(matrix.variations?.taskPrompt, matrix.base.taskPrompt);

  const defs: ExperimentDefinition[] = [];
  for (const systemPrompt of systemPrompts) {
    for (const model of models) {
      for (const taskPrompt of taskPrompts) {
        const candidate = {
          name: matrix.base.name,
          systemPrompt,
          model,
          taskPrompt,
          sandbox: matrix.base.sandbox,
        };
        const def = loadExperiment(candidate, logger);
        // Disambiguate names across the product.
        def.name = `${def.name}#${defs.length + 1}`;
        defs.push(def);
      }
    }
  }

  logger?.debug(
    { marker: "BLOCK_EXPAND_MATRIX", count: defs.length },
    "[Config][expandMatrix][BLOCK_EXPAND_MATRIX] expanded",
  );
  return defs;
  // END_BLOCK_EXPAND_MATRIX
}

// --- private helpers (kept out of shared graph artifacts) ---

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`field "${key}" must be a non-empty string when present`);
  }
  return value;
}

function normalizeSandbox(raw: unknown): SandboxOptions {
  if (raw === undefined) return { ...DEFAULT_SANDBOX, networkAllowlist: [...DEFAULT_SANDBOX.networkAllowlist] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`field "sandbox" must be an object when present`);
  }
  const s = raw as Record<string, unknown>;

  const image = s.image === undefined ? DEFAULT_SANDBOX.image : asNonEmptyString(s.image, "sandbox.image");
  const timeoutMs = s.timeoutMs === undefined ? DEFAULT_SANDBOX.timeoutMs : asPositiveInt(s.timeoutMs, "sandbox.timeoutMs");
  const networkAllowlist = s.networkAllowlist === undefined ? [] : asStringArray(s.networkAllowlist, "sandbox.networkAllowlist");

  const sandbox: SandboxOptions = { image, networkAllowlist, timeoutMs };
  if (s.networkMode !== undefined) {
    if (s.networkMode !== "open" && s.networkMode !== "vacuum") {
      throw new ConfigError(`field "sandbox.networkMode" must be "open" or "vacuum"`);
    }
    sandbox.networkMode = s.networkMode;
  }
  if (s.backend !== undefined) {
    if (s.backend !== "docker" && s.backend !== "microsandbox") {
      throw new ConfigError(`field "sandbox.backend" must be "docker" or "microsandbox"`);
    }
    sandbox.backend = s.backend;
  }
  if (s.resourceLimits !== undefined) {
    if (typeof s.resourceLimits !== "object" || s.resourceLimits === null) {
      throw new ConfigError(`field "sandbox.resourceLimits" must be an object when present`);
    }
    const rl = s.resourceLimits as Record<string, unknown>;
    const resourceLimits: { cpus?: number; memoryMb?: number } = {};
    if (rl.cpus !== undefined) resourceLimits.cpus = asPositiveInt(rl.cpus, "sandbox.resourceLimits.cpus");
    if (rl.memoryMb !== undefined) resourceLimits.memoryMb = asPositiveInt(rl.memoryMb, "sandbox.resourceLimits.memoryMb");
    sandbox.resourceLimits = resourceLimits;
  }
  return sandbox;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`field "${label}" must be a non-empty string`);
  }
  return value;
}

function asPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`field "${label}" must be a positive integer`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new ConfigError(`field "${label}" must be an array of non-empty strings`);
  }
  return [...(value as string[])];
}

function nonEmptyAxis(axis: string[] | undefined, fallback: string): string[] {
  if (axis === undefined) return [fallback];
  if (!Array.isArray(axis) || axis.length === 0) {
    throw new ConfigError("variation axis must be a non-empty array when present");
  }
  return axis;
}

function defaultName(model: string): string {
  return `experiment-${model.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}
