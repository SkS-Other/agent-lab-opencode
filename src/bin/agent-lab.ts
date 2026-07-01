#!/usr/bin/env node
// FILE: src/bin/agent-lab.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Executable entry for the agent-lab CLI; dispatch argv to M-CLI main and exit with its code.
//   SCOPE: process argv/exit wiring only
//   DEPENDS: M-CLI
//   LINKS: M-CLI
//   ROLE: SCRIPT
//   MAP_MODE: NONE
// END_MODULE_CONTRACT
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Node-portable bin wrapper (replaces import.meta.main) for npm/standalone builds.
// END_CHANGE_SUMMARY

import { main } from "../cli/index.ts";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[agent-lab] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
