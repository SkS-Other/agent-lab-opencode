// FILE: src/mcp/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Expose the engine to agents over MCP (stdio) as tools: run_experiment, list_runs, get_run, compare_runs.
//   SCOPE: createToolHandlers (pure, testable), createMcpServer (registers tools), main (stdio transport)
//   DEPENDS: M-ENGINE, M-CONFIG, M-STORE, M-LOGGER
//   LINKS: M-MCP, V-M-MCP
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createToolHandlers - engine-backed tool implementations (no stdio/SDK; directly testable)
//   createMcpServer - build an McpServer with the tools registered
//   main - connect the server over StdioServerTransport
//   McpDeps - injectable ports (logger, store, engine fns)
//   ToolHandlers - the four tool handler functions
//   ToolResult - MCP tool result shape ({ content, structuredContent?, isError? })
//   RunExperimentArgs - typed args for the run_experiment tool
//   MCP_TOOL_FAILED - stable error code constant
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-MCP: stdio MCP server exposing the engine, with testable tool handlers.
// END_CHANGE_SUMMARY

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadExperiment } from "../config/index.ts";
import { compareRuns, createStore, runExperiment } from "../engine/index.ts";
import { createLogger, type Logger } from "../logger/index.ts";
import type { TraceStore } from "../store/index.ts";

export const MCP_TOOL_FAILED = "MCP_TOOL_FAILED" as const;

const SERVER_NAME = "agent-lab";
const SERVER_VERSION = "0.1.0";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // MCP's CallToolResult carries an open index signature; mirror it so handlers type-check.
  [x: string]: unknown;
}

export interface McpDeps {
  logger: Logger;
  store?: TraceStore;
  run?: typeof runExperiment;
  compare?: typeof compareRuns;
}

export interface RunExperimentArgs {
  systemPrompt: string;
  model: string;
  taskPrompt: string;
  image?: string;
  networkAllowlist?: string[];
  timeoutMs?: number;
  concurrency?: number;
}

export interface ToolHandlers {
  run_experiment(args: RunExperimentArgs): Promise<ToolResult>;
  list_runs(): Promise<ToolResult>;
  get_run(args: { runId: string }): Promise<ToolResult>;
  compare_runs(args: { runIds: string[] }): Promise<ToolResult>;
}

// START_CONTRACT: createToolHandlers
//   PURPOSE: Build engine-backed MCP tool handlers that are directly callable in tests (no stdio).
//   INPUTS: { deps: McpDeps }
//   OUTPUTS: { ToolHandlers }
//   SIDE_EFFECTS: drives the engine/store when invoked; logs to the provided logger
//   LINKS: M-MCP, V-M-MCP, MCP_TOOL_FAILED
// END_CONTRACT: createToolHandlers
export function createToolHandlers(deps: McpDeps): ToolHandlers {
  const { logger } = deps;
  const store = deps.store ?? createStore({ logger });
  const run = deps.run ?? runExperiment;
  const compare = deps.compare ?? compareRuns;

  // START_BLOCK_HANDLE_TOOL
  const guard = async (tool: string, fn: () => Promise<unknown>): Promise<ToolResult> => {
    logger.info({ marker: "BLOCK_HANDLE_TOOL", tool }, `[Mcp][handleTool][BLOCK_HANDLE_TOOL] ${tool}`);
    try {
      return ok(await fn());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ marker: "BLOCK_HANDLE_TOOL", tool }, `[Mcp][handleTool][BLOCK_HANDLE_TOOL] ${tool} failed`);
      return fail(`${MCP_TOOL_FAILED}: ${message}`);
    }
  };
  // END_BLOCK_HANDLE_TOOL

  return {
    run_experiment: (args) =>
      guard("run_experiment", async () => {
        const hasSandbox = args.image !== undefined || args.networkAllowlist !== undefined || args.timeoutMs !== undefined;
        const def = loadExperiment(
          {
            systemPrompt: args.systemPrompt,
            model: args.model,
            taskPrompt: args.taskPrompt,
            ...(hasSandbox
              ? {
                  sandbox: {
                    ...(args.image !== undefined ? { image: args.image } : {}),
                    ...(args.networkAllowlist !== undefined ? { networkAllowlist: args.networkAllowlist } : {}),
                    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
                  },
                }
              : {}),
          },
          logger,
        );
        const results = await run(def, {
          logger,
          store,
          ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
        });
        return { results };
      }),

    list_runs: () => guard("list_runs", async () => ({ runs: await store.listRuns() })),

    get_run: (args) => guard("get_run", async () => ({ run: await store.getRun(args.runId) })),

    compare_runs: (args) => guard("compare_runs", async () => await compare(args.runIds, { logger, store })),
  };
}

// START_CONTRACT: createMcpServer
//   PURPOSE: Build an McpServer with the four engine-backed tools registered and zod input schemas.
//   INPUTS: { deps: McpDeps }
//   OUTPUTS: { McpServer }
//   SIDE_EFFECTS: none until connected to a transport
//   LINKS: M-MCP
// END_CONTRACT: createMcpServer
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const handlers = createToolHandlers(deps);

  server.registerTool(
    "run_experiment",
    {
      title: "Run experiment",
      description: "Run an OpenCode agent in an isolated sandbox with the given system prompt, model, and task prompt.",
      inputSchema: {
        systemPrompt: z.string(),
        model: z.string(),
        taskPrompt: z.string(),
        image: z.string().optional(),
        networkAllowlist: z.array(z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
        concurrency: z.number().int().positive().optional(),
      },
    },
    (args) => handlers.run_experiment(args),
  );

  server.registerTool(
    "list_runs",
    { title: "List runs", description: "List all known experiment runs.", inputSchema: {} },
    () => handlers.list_runs(),
  );

  server.registerTool(
    "get_run",
    { title: "Get run", description: "Fetch one run record with its full trace by id.", inputSchema: { runId: z.string() } },
    (args) => handlers.get_run(args),
  );

  server.registerTool(
    "compare_runs",
    {
      title: "Compare runs",
      description: "Diff two or more runs against the first (baseline).",
      inputSchema: { runIds: z.array(z.string()).min(2) },
    },
    (args) => handlers.compare_runs(args),
  );

  return server;
}

// START_CONTRACT: main
//   PURPOSE: Start the MCP server over stdio (stdout is the transport; logs go to stderr).
//   INPUTS: {}
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: connects stdio transport
//   LINKS: M-MCP
// END_CONTRACT: main
export async function main(): Promise<void> {
  // stdout is reserved for the MCP transport, so structured logs must go to stderr.
  const logger = createLogger({ level: "info", destination: process.stderr });
  const server = createMcpServer({ logger });
  await server.connect(new StdioServerTransport());
}

// --- private helpers ---

function ok(data: unknown): ToolResult {
  const structured = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { value: data };
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: structured };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

