# Agent Lab

Run and test agentic systems in isolation. Agent Lab runs **OpenCode** in a Docker sandbox
("vacuum") with controlled settings and lets you observe how an agent behaves under varied
**system prompts, models, and task prompts** — one run or many in parallel. It is built
primarily to be **called by agents** (over MCP), and secondarily by humans (CLI).

- Vary system prompt / model / task prompt; run isolated, capture the full behavior trace.
- Two interfaces over one engine: **MCP** (stdio) and **CLI** — both agent-friendly.
- Three network modes and guaranteed sandbox teardown.

## Prerequisites

1. **Bun** 1.x — `bun --version`
2. **Docker** running — `docker --version`
3. **OpenCode configured on the host** — a provider set up in `~/.config/opencode` (auth in
   `~/.local/share/opencode`). These are mounted **read-only** into each sandbox; nothing is
   baked into the image.

## Install

Pick one. All three give you the `agent-lab` (CLI) and `agent-lab-mcp` (MCP server) commands.
Docker (or the microsandbox runtime) and the sandbox image are separate prerequisites — see below.

**npm (needs Node ≥ 22):**

```sh
npm install -g agent-lab-opencode
# or run without installing:  npx -y agent-lab-opencode-mcp
```

**Standalone binary (no Node/Bun required)** — download for your platform from the
[latest release](https://github.com/ShutovKS/agent-lab-opencode/releases/latest), e.g.:

```sh
curl -fsSL -o agent-lab https://github.com/ShutovKS/agent-lab-opencode/releases/latest/download/agent-lab-darwin-arm64
chmod +x agent-lab
```

**From source (Bun):**

```sh
bun install
bun link                                             # exposes `agent-lab` + `agent-lab-mcp` on PATH
```

Get the sandbox image (opencode serve) — either pull the published multi-arch image:

```sh
docker pull ghcr.io/shutovks/agent-lab-opencode:latest
docker tag ghcr.io/shutovks/agent-lab-opencode:latest agent-lab-opencode:latest
```

…or build it locally:

```sh
docker build -t agent-lab-opencode:latest docker/
```

> The engine, CLI, and MCP server all run **on the host** (where Docker + your OpenCode config
> live). Experiments run inside isolated containers. Runs are persisted under `runs/<runId>/`
> relative to the working directory the server/CLI is launched from.

## Use from an agent — MCP (recommended)

Agent Lab exposes an MCP stdio server with four tools:

| Tool | Arguments | Returns |
|---|---|---|
| `run_experiment` | `systemPrompt, model, taskPrompt, image?, networkAllowlist?, networkMode?, timeoutMs?, concurrency?` | `runId` + `status` |
| `list_runs` | — | known runs |
| `get_run` | `runId` | full run record + trace (steps, tool calls, tokens, output, git diff) |
| `compare_runs` | `runIds[]` (≥2) | structural behavior diff vs. the first (baseline) |

### Claude Code

This repo ships a `.mcp.json`, so opening the project in Claude Code registers the server
automatically. To use it from **any** project after `bun link`:

```json
{
  "mcpServers": {
    "agent-lab": {
      "command": "agent-lab-mcp"
    }
  }
}
```

### OpenCode

In `opencode.json` (or `~/.config/opencode/opencode.jsonc`):

```json
{
  "mcp": {
    "agent-lab": {
      "type": "local",
      "command": ["agent-lab-mcp"]
    }
  }
}
```

### Typical agent flow

1. `run_experiment` with prompt variant A → `runId_A`
2. `run_experiment` with prompt variant B → `runId_B`
3. `compare_runs [runId_A, runId_B]` → see which variant used fewer steps/tokens or a different
   tool sequence. Results come back as text **and** `structuredContent` (machine-readable).

## Use from a shell — CLI

Agents with a shell tool (and humans) can call the CLI; every command prints parseable JSON.

```sh
agent-lab run --system "You are careful." --model cpa/glm-5.2 --task "Refactor the parser."
agent-lab run --config matrix.json --concurrency 3   # variation matrix, run in parallel
agent-lab run --from <runId>                          # replay a stored experiment
agent-lab list
agent-lab show <runId>
agent-lab compare <runId-a> <runId-b>
```

Config file (`--config`) is either a single definition or a variation matrix:

```json
{
  "base": {
    "systemPrompt": "You are a concise agent.",
    "model": "cpa/glm-5.2",
    "taskPrompt": "placeholder",
    "sandbox": { "image": "agent-lab-opencode:latest", "networkAllowlist": ["cpa.funxyz.fun"], "timeoutMs": 120000 }
  },
  "variations": { "taskPrompt": ["Task A", "Task B"] }
}
```

## Sandbox backends

Set `backend` on the sandbox options:

- **`docker`** (default) — one container per run; strong FS/PID/network isolation; the vacuum
  network mode is enforced with an in-container iptables allowlist. Requires Docker.
- **`microsandbox`** — a **libkrun microVM** per run, **no Docker daemon**. Same behavior behind
  the same contract (port publish, `NetworkPolicy` egress allowlist, guaranteed teardown).
  Requires the microsandbox runtime (`curl -fsSL https://install.microsandbox.dev | sh`) and a
  **registry** image (microsandbox pulls images from a registry, not a local Docker build), on
  macOS Apple Silicon or Linux+KVM. The SDK is lazy-loaded, so the Docker path never touches it.

## Network modes

Set `networkMode` on the sandbox options:

- **`open`** (default) — bridge networking; the agent can reach its LLM. Fast, egress open.
- **`vacuum`** — strict deny-by-default egress via an in-container iptables allowlist (only DNS +
  the resolved allowlist hosts, e.g. the LLM endpoint + opencode infra). IPv6 fails closed.

## What gets captured (RunTrace)

`runId`, experiment metadata, `status` (`success`/`error`/`timeout`), `timings`, ordered `steps`
(assistant messages + tool calls with ok/error), `tokenUsage`, `finalOutput` (text + git diff),
and `error`/`partial` when relevant.

## More

- `docs/LIVE_RUN.md` — end-to-end live run walkthrough.
- `docs/` — GRACE artifacts (requirements, technology, development plan, verification plan,
  knowledge graph). `AGENTS.md` — engineering protocol.

## Known limitations

- Teardown is guaranteed on normal, error, timeout, and container-crash paths, but **not** if the
  host `agent-lab` process is hard-killed (`SIGKILL`). Containers are labeled `agent-lab.sandbox=1`
  for cleanup: `docker ps -aq --filter label=agent-lab.sandbox=1 | xargs docker rm -f`.
- Vacuum: IPv6 is only reachable under a non-default docker IPv6 setup; DNS exfiltration to the
  configured resolver remains theoretically possible.
