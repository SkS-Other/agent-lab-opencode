// FILE: scripts/live-smoke.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Drive one real end-to-end experiment against the live OpenCode sandbox image (manual gate, VF-001).
//   SCOPE: build a definition, run it through the real executor, persist, print the run result
//   DEPENDS: M-ENGINE, M-CONFIG, M-LOGGER
//   LINKS: M-OPENCODE, M-SANDBOX, V-M-OPENCODE
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   model - provider/model from argv[2] or AGENT_LAB_MODEL
//   task - task prompt from argv[3] or a default
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial live smoke harness for the gated phase-level run.
// END_CHANGE_SUMMARY
//
// Usage:
//   1. docker build -t agent-lab-opencode:latest docker/
//   2. ensure your OpenCode provider is configured (~/.config/opencode, ~/.local/share/opencode)
//   3. bun scripts/live-smoke.ts <provider/model> ["task prompt"]

import { loadExperiment } from "../src/config/index.ts";
import { createDefaultExecutor, createStore, runExperiment } from "../src/engine/index.ts";
import { createLogger } from "../src/logger/index.ts";

const model = process.argv[2] ?? process.env.AGENT_LAB_MODEL;
if (model === undefined || model.length === 0) {
  console.error('usage: bun scripts/live-smoke.ts <provider/model> ["task prompt"]');
  process.exit(2);
}
const task = process.argv[3] ?? 'Create a file named hello.txt containing the text "hello from agent-lab".';

const logger = createLogger({ level: "info" });
// AGENT_LAB_VACUUM=1 enables the strict egress allowlist; AGENT_LAB_ALLOW overrides the LLM host(s).
const vacuum = process.env.AGENT_LAB_VACUUM === "1";
const allowHosts = (process.env.AGENT_LAB_ALLOW ?? "cpa.funxyz.fun").split(",");
const definition = loadExperiment({
  name: "live-smoke",
  systemPrompt: "You are a helpful coding agent operating inside an isolated sandbox.",
  model,
  taskPrompt: task,
  sandbox: {
    image: "agent-lab-opencode:latest",
    networkAllowlist: vacuum ? allowHosts : ["llm-endpoint"],
    timeoutMs: 120_000,
    ...(vacuum ? { networkMode: "vacuum" as const } : {}),
  },
});

const store = createStore({ logger, baseDir: "runs" });
const results = await runExperiment(definition, { logger, store, executor: createDefaultExecutor({ logger }) });

console.log(JSON.stringify({ command: "live-smoke", results }, null, 2));
process.exit(results.every((r) => r.status === "success") ? 0 : 1);
