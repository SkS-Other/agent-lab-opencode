# Live Run Guide

How to run a real experiment end to end (the phase-level gate for the `partial` modules
M-SANDBOX and M-OPENCODE). Module-level tests cover the logic on fakes; this exercises the
real Docker sandbox + `@opencode-ai/sdk` path.

## Prerequisites

- Docker running locally
- An OpenCode provider configured on the host (a custom provider is fine):
  - `~/.config/opencode/` — provider/model config
  - `~/.local/share/opencode/` — auth (e.g. `auth.json`)
  These are mounted **read-only** into the sandbox; nothing is baked into the image.

## 1. Build the sandbox image

```sh
docker build -t agent-lab-opencode:latest docker/
```

The image installs the OpenCode CLI and starts `opencode serve` on port 4096. The host
publishes a random loopback port; the SDK driver connects to it and waits for readiness.

## 2. Run the smoke test

```sh
bun scripts/live-smoke.ts <provider/model> "optional task prompt"
# example:
bun scripts/live-smoke.ts anthropic/claude-opus-4-8 "Create hello.txt with 'hi'."
```

What happens (DF-001):

1. M-ENGINE provisions a container (`agent-lab-opencode`), publishing port 4096 and mounting
   your OpenCode config read-only.
2. M-SANDBOX waits for the endpoint to become ready (`BLOCK_WAIT_READY`).
3. M-OPENCODE connects via `createOpencodeClient`, creates a session, and prompts with your
   system prompt + model + task.
4. The response parts are normalized into a `RunTrace`; the session git diff is captured.
5. The run is persisted under `runs/<runId>/` and the container is torn down (guaranteed).

Output is the JSON run result; the full trace is in `runs/<runId>/trace.json`.

## 3. Inspect and compare

```sh
bun src/cli/index.ts list
bun src/cli/index.ts show <runId>
bun src/cli/index.ts compare <runId-a> <runId-b>
```

## Networking note

Current isolation is **basic**: filesystem/process isolation via the container, with bridge
networking (egress open). A strict deny-by-default + allowlist (proxy/iptables) is a separate
follow-up — see `docs/verification-plan.xml` VF-003.
