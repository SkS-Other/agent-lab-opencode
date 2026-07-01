#!/usr/bin/env node
// FILE: src/bin/agent-lab-mcp.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Executable entry for the agent-lab MCP server; start the stdio server and fail loudly on error.
//   SCOPE: process startup/exit wiring only
//   DEPENDS: M-MCP
//   LINKS: M-MCP
//   ROLE: SCRIPT
//   MAP_MODE: NONE
// END_MODULE_CONTRACT
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Node-portable bin wrapper (replaces import.meta.main) for npm/standalone builds.
// END_CHANGE_SUMMARY

import { main } from "../mcp/index.ts";

main().catch((err) => {
  process.stderr.write(`[agent-lab-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
