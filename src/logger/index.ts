// FILE: src/logger/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Create structured pino loggers with stable marker bindings and secret redaction shared by all modules.
//   SCOPE: createLogger, redaction config, marker-field bindings (runId/correlationId/sandboxId)
//   DEPENDS: none
//   LINKS: M-LOGGER, V-M-LOGGER
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createLogger - build a child logger with redaction + marker bindings
//   LogBindings - stable marker fields bound to every line
//   Logger - re-exported pino.Logger type for downstream modules
//   REDACTED_PATHS - default redaction paths (secrets never logged)
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-LOGGER: pino factory with redaction and marker bindings.
// END_CHANGE_SUMMARY

import pino, { type Logger } from "pino";

export type { Logger };

export interface LogBindings {
  runId?: string;
  correlationId?: string;
  sandboxId?: string;
}

export interface CreateLoggerOptions {
  bindings?: LogBindings;
  level?: pino.LevelWithSilent;
  /** Optional destination stream; defaults to pino's standard stdout sink. */
  destination?: pino.DestinationStream;
  /** Extra redaction paths merged with the defaults. */
  redactPaths?: string[];
}

/**
 * Default redaction paths. Secrets, credentials, and raw provider payloads must never
 * reach a log sink or a persisted trace (GlobalPolicy.redaction).
 */
export const REDACTED_PATHS: string[] = [
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "password",
  "secret",
  "authorization",
  "Authorization",
  "headers.authorization",
  "env.ANTHROPIC_API_KEY",
  "env.OPENAI_API_KEY",
  "env.OPENCODE_API_KEY",
  "*.apiKey",
  "*.token",
  "*.secret",
];

export const REDACTED_VALUE = "[REDACTED]" as const;

// START_CONTRACT: createLogger
//   PURPOSE: Build a structured child logger that redacts secrets and binds stable marker fields.
//   INPUTS: { options?: CreateLoggerOptions - bindings, level, destination, extra redact paths }
//   OUTPUTS: { Logger - pino logger with redaction applied }
//   SIDE_EFFECTS: writes to the configured destination when used (none at creation)
//   LINKS: M-LOGGER, V-M-LOGGER, REDACTED_PATHS
// END_CONTRACT: createLogger
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  // START_BLOCK_REDACT_FIELDS
  const paths = dedupe([...REDACTED_PATHS, ...(options.redactPaths ?? [])]);
  const base = pino(
    {
      level: options.level ?? "info",
      redact: { paths, censor: REDACTED_VALUE },
      base: undefined, // omit pid/hostname noise; markers carry the signal
    },
    options.destination,
  );
  const bindings = options.bindings ?? {};
  const logger = base.child(compact(bindings));
  logger.debug(
    { marker: "BLOCK_REDACT_FIELDS", redactPathCount: paths.length },
    "[Logger][createLogger][BLOCK_REDACT_FIELDS] redaction configured",
  );
  return logger;
  // END_BLOCK_REDACT_FIELDS
}

// --- private helpers ---

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function compact(bindings: LogBindings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}
