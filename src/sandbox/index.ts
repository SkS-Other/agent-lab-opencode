// FILE: src/sandbox/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provision and tear down an isolated Docker container per run with deny-by-default networking and guaranteed cleanup.
//   SCOPE: createSandbox, withSandbox, buildRunArgs, SandboxHandle/SandboxSpec/DockerEngine, real docker-CLI engine
//   DEPENDS: M-LOGGER
//   LINKS: M-SANDBOX, V-M-SANDBOX, VF-003, VF-004
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createSandbox - provision an isolated container, return a lifecycle handle
//   withSandbox - run a function with a sandbox and guarantee dispose() (BLOCK_TEARDOWN)
//   buildRunArgs - pure: translate a SandboxSpec into docker run arguments (network policy + port publish)
//   createDockerEngine - real DockerEngine backed by the docker CLI via Bun.spawn
//   SandboxSpec - image, network allowlist, env, mounts, resource limits, publishPort
//   SandboxMount - one source->target mount
//   SandboxHandle - { sandboxId, endpoint?, exec, dispose }
//   ExecResult - { stdout, stderr, exitCode }
//   DockerEngine - injectable container backend (faked in tests)
//   SandboxDeps - { logger, engine?, ready? } for createSandbox/withSandbox
//   ReadyProbe - injectable endpoint readiness probe
//   SandboxError - typed error (SANDBOX_PROVISION_FAILED | SANDBOX_TEARDOWN_FAILED)
//   SANDBOX_PROVISION_FAILED - stable error code constant
//   SANDBOX_TEARDOWN_FAILED - stable error code constant
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.1.0 - Add publishPort + handle.endpoint + DockerEngine.port + injectable readiness probe for live runs.
//   LAST_CHANGE: v1.0.0 - Initial M-SANDBOX: DI docker engine, network policy build, guaranteed teardown.
// END_CHANGE_SUMMARY

import type { Logger } from "../logger/index.ts";

export const SANDBOX_PROVISION_FAILED = "SANDBOX_PROVISION_FAILED" as const;
export const SANDBOX_TEARDOWN_FAILED = "SANDBOX_TEARDOWN_FAILED" as const;

export class SandboxError extends Error {
  constructor(
    readonly code: typeof SANDBOX_PROVISION_FAILED | typeof SANDBOX_TEARDOWN_FAILED,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface SandboxMount {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface SandboxSpec {
  image: string;
  /** Hosts the container may reach. Empty => full network vacuum (--network none). */
  networkAllowlist: string[];
  env?: Record<string, string>;
  mounts?: SandboxMount[];
  resourceLimits?: { cpus?: number; memoryMb?: number };
  /** Command to keep the container alive while the adapter drives it. */
  entrypoint?: string[];
  /** Container port to publish to the host (e.g. the opencode serve port). Enables handle.endpoint. */
  publishPort?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  /** Host-reachable URL of the published port once ready (set only when publishPort is used). */
  readonly endpoint?: string;
  exec(cmd: string[]): Promise<ExecResult>;
  /** Idempotent teardown; safe to call more than once. */
  dispose(): Promise<void>;
}

/** Injectable container backend. The real one shells out to docker; tests pass a fake. */
export interface DockerEngine {
  run(args: string[]): Promise<{ containerId: string }>;
  exec(containerId: string, cmd: string[]): Promise<ExecResult>;
  remove(containerId: string): Promise<void>;
  /** Resolve the host port mapped to a container port. */
  port(containerId: string, containerPort: number): Promise<number>;
}

/** Probe that resolves once an endpoint is reachable, or rejects on timeout. */
export type ReadyProbe = (url: string) => Promise<void>;

export interface SandboxDeps {
  logger: Logger;
  engine?: DockerEngine;
  ready?: ReadyProbe;
}

// START_CONTRACT: buildRunArgs
//   PURPOSE: Translate a SandboxSpec into deterministic `docker run` arguments, applying the network policy.
//   INPUTS: { spec: SandboxSpec }
//   OUTPUTS: { string[] - args following `docker run -d` }
//   SIDE_EFFECTS: none (pure)
//   LINKS: M-SANDBOX, VF-003
// END_CONTRACT: buildRunArgs
export function buildRunArgs(spec: SandboxSpec): string[] {
  const args: string[] = [];

  // Network policy: empty allowlist => full vacuum. Non-empty => isolated bridge; host-level
  // egress filtering to the allowlist is enforced by the phase-level live setup (see V-M-SANDBOX).
  if (spec.networkAllowlist.length === 0) {
    args.push("--network", "none");
  } else {
    args.push("--network", "bridge");
    for (const host of spec.networkAllowlist) {
      args.push("--label", `agent-lab.allow=${host}`);
    }
  }

  if (spec.publishPort !== undefined) {
    // Publish to a random host port bound to loopback only.
    args.push("-p", `127.0.0.1::${spec.publishPort}`);
  }

  if (spec.resourceLimits?.cpus !== undefined) args.push("--cpus", String(spec.resourceLimits.cpus));
  if (spec.resourceLimits?.memoryMb !== undefined) args.push("--memory", `${spec.resourceLimits.memoryMb}m`);

  for (const [key, value] of Object.entries(spec.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  for (const mount of spec.mounts ?? []) {
    args.push("-v", `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
  }

  args.push(spec.image);
  if (spec.entrypoint) args.push(...spec.entrypoint);
  return args;
}

// START_CONTRACT: createSandbox
//   PURPOSE: Provision an isolated container and return a lifecycle handle, or fail without leaking resources.
//   INPUTS: { spec: SandboxSpec, deps: SandboxDeps }
//   OUTPUTS: { Promise<SandboxHandle> }
//   SIDE_EFFECTS: creates a docker container via the engine; logs network policy + teardown
//   LINKS: M-SANDBOX, V-M-SANDBOX, SANDBOX_PROVISION_FAILED
// END_CONTRACT: createSandbox
export async function createSandbox(spec: SandboxSpec, deps: SandboxDeps): Promise<SandboxHandle> {
  const { logger } = deps;
  const engine = deps.engine ?? createDockerEngine();

  // START_BLOCK_APPLY_NETWORK_POLICY
  const args = buildRunArgs(spec);
  logger.info(
    {
      marker: "BLOCK_APPLY_NETWORK_POLICY",
      networkMode: spec.networkAllowlist.length === 0 ? "none" : "allowlist",
      allowlistSize: spec.networkAllowlist.length,
    },
    "[Sandbox][createSandbox][BLOCK_APPLY_NETWORK_POLICY] applying network policy",
  );

  let containerId: string;
  try {
    ({ containerId } = await engine.run(args));
  } catch (err) {
    // No handle is returned and no container id is logged: nothing leaks on provision failure.
    logger.error({ marker: "BLOCK_APPLY_NETWORK_POLICY" }, "[Sandbox][createSandbox][BLOCK_APPLY_NETWORK_POLICY] provision failed");
    throw new SandboxError(SANDBOX_PROVISION_FAILED, "failed to provision sandbox container", err);
  }
  // END_BLOCK_APPLY_NETWORK_POLICY

  // START_BLOCK_WAIT_READY
  let endpoint: string | undefined;
  if (spec.publishPort !== undefined) {
    const ready = deps.ready ?? defaultReadyProbe;
    try {
      const hostPort = await engine.port(containerId, spec.publishPort);
      endpoint = `http://127.0.0.1:${hostPort}`;
      await ready(endpoint);
      logger.info(
        { marker: "BLOCK_WAIT_READY", sandboxId: containerId, endpoint },
        "[Sandbox][createSandbox][BLOCK_WAIT_READY] endpoint ready",
      );
    } catch (err) {
      // Endpoint never came up: remove the container we just started so nothing leaks.
      await engine.remove(containerId).catch(() => {});
      logger.error({ marker: "BLOCK_WAIT_READY", sandboxId: containerId }, "[Sandbox][createSandbox][BLOCK_WAIT_READY] endpoint not ready");
      throw new SandboxError(SANDBOX_PROVISION_FAILED, "sandbox endpoint did not become ready", err);
    }
  }
  // END_BLOCK_WAIT_READY

  let disposed = false;
  const handle: SandboxHandle = {
    sandboxId: containerId,
    ...(endpoint !== undefined ? { endpoint } : {}),
    async exec(cmd: string[]): Promise<ExecResult> {
      return engine.exec(containerId, cmd);
    },
    async dispose(): Promise<void> {
      // START_BLOCK_TEARDOWN
      if (disposed) return;
      disposed = true;
      try {
        await engine.remove(containerId);
        logger.info({ marker: "BLOCK_TEARDOWN", sandboxId: containerId }, "[Sandbox][createSandbox][BLOCK_TEARDOWN] disposed");
      } catch (err) {
        logger.error({ marker: "BLOCK_TEARDOWN", sandboxId: containerId }, "[Sandbox][createSandbox][BLOCK_TEARDOWN] teardown failed");
        throw new SandboxError(SANDBOX_TEARDOWN_FAILED, `failed to remove container ${containerId}`, err);
      }
      // END_BLOCK_TEARDOWN
    },
  };
  return handle;
}

// START_CONTRACT: withSandbox
//   PURPOSE: Run a function against a fresh sandbox and guarantee teardown on every path (VF-004).
//   INPUTS: { spec: SandboxSpec, deps: SandboxDeps, fn: (handle) => Promise<T> }
//   OUTPUTS: { Promise<T> - fn's result }
//   SIDE_EFFECTS: provisions and always disposes the sandbox
//   LINKS: M-SANDBOX, VF-004
// END_CONTRACT: withSandbox
export async function withSandbox<T>(
  spec: SandboxSpec,
  deps: SandboxDeps,
  fn: (handle: SandboxHandle) => Promise<T>,
): Promise<T> {
  const handle = await createSandbox(spec, deps);
  try {
    return await fn(handle);
  } finally {
    await handle.dispose();
  }
}

// START_CONTRACT: createDockerEngine
//   PURPOSE: Build a DockerEngine backed by the docker CLI via Bun.spawn.
//   INPUTS: {}
//   OUTPUTS: { DockerEngine }
//   SIDE_EFFECTS: spawns docker processes when used
//   LINKS: M-SANDBOX
// END_CONTRACT: createDockerEngine
export function createDockerEngine(): DockerEngine {
  return {
    async run(args: string[]): Promise<{ containerId: string }> {
      const result = await spawnDocker(["run", "-d", ...args]);
      if (result.exitCode !== 0) {
        throw new Error(`docker run failed (${result.exitCode}): ${result.stderr.trim()}`);
      }
      return { containerId: result.stdout.trim() };
    },
    async exec(containerId: string, cmd: string[]): Promise<ExecResult> {
      return spawnDocker(["exec", containerId, ...cmd]);
    },
    async remove(containerId: string): Promise<void> {
      const result = await spawnDocker(["rm", "-f", containerId]);
      if (result.exitCode !== 0) {
        throw new Error(`docker rm failed (${result.exitCode}): ${result.stderr.trim()}`);
      }
    },
    async port(containerId: string, containerPort: number): Promise<number> {
      const result = await spawnDocker(["port", containerId, String(containerPort)]);
      if (result.exitCode !== 0) {
        throw new Error(`docker port failed (${result.exitCode}): ${result.stderr.trim()}`);
      }
      // First mapping line looks like "127.0.0.1:49153" or "0.0.0.0:49153".
      const line = result.stdout.split("\n").find((l) => l.includes(":"));
      const match = line?.match(/:(\d+)\s*$/);
      if (!match) throw new Error(`could not parse host port from: ${result.stdout.trim()}`);
      return Number(match[1]);
    },
  };
}

// --- private helpers ---

/** Default readiness probe: poll the endpoint until it answers (any non-5xx) or the deadline passes. */
async function defaultReadyProbe(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`endpoint ${url} not ready within ${timeoutMs}ms`, { cause: lastErr });
}

async function spawnDocker(args: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
