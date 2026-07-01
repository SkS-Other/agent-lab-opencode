// FILE: src/sandbox/microsandbox.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide a non-Docker sandbox backend using microsandbox (libkrun microVM) behind the same SandboxHandle contract.
//   SCOPE: createMicrosandbox, MicrosandboxClient/MicroSandboxInstance ports, real SDK adapter, network-policy mapping, guaranteed teardown
//   DEPENDS: M-SANDBOX, M-LOGGER
//   LINKS: M-SANDBOX, V-M-SANDBOX
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createMicrosandbox - provision a microVM sandbox, start opencode serve, return a SandboxHandle
//   createRealMicrosandboxClient - lazy adapter over the microsandbox SDK (native libkrun); not loaded in tests
//   MicrosandboxClient - injectable port that creates a microVM instance (faked in tests)
//   MicroSandboxInstance - injectable per-sandbox port: execStream / exec / stop
//   MicroProcess - handle to a long-lived guest process (opencode serve): kill()
//   MicroExecResult - exec output shape ({ stdout(), stderr(), code })
//   MicroCreateOptions - options passed to MicrosandboxClient.create
//   MicrosandboxDeps - { logger, client?, ready?, hostPort? }
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial microsandbox (libkrun microVM) backend behind the SandboxHandle contract.
// END_CHANGE_SUMMARY

import type { Logger } from "../logger/index.ts";
import type { ReadyProbe, SandboxHandle, SandboxSpec } from "./index.ts";
import { SANDBOX_PROVISION_FAILED, SandboxError } from "./index.ts";

/** opencode serve port inside the microVM (guest side). */
const DEFAULT_GUEST_PORT = 4096;
/** Hosts opencode itself needs regardless of the experiment (mirrors the Docker vacuum base hosts). */
const VACUUM_BASE_HOSTS = ["models.dev", "opencode.ai", "registry.npmjs.org"];

export interface MicroExecResult {
  stdout(): string;
  stderr(): string;
  code: number;
}

/** Handle to a running long-lived process (opencode serve) inside the microVM. */
export interface MicroProcess {
  kill(): Promise<void>;
}

/** Per-sandbox operations. The real one wraps a microsandbox Sandbox; tests pass a fake. */
export interface MicroSandboxInstance {
  execStream(cmd: string, args: string[]): Promise<MicroProcess>;
  exec(cmd: string, args: string[]): Promise<MicroExecResult>;
  stop(): Promise<void>;
}

export interface MicroCreateOptions {
  name: string;
  image: string;
  hostPort: number;
  guestPort: number;
  vacuum: boolean;
  allowlist: string[];
  mounts: Array<{ host: string; guest: string; readonly: boolean }>;
}

/** Injectable backend port. The real one lazily loads the microsandbox SDK. */
export interface MicrosandboxClient {
  create(opts: MicroCreateOptions): Promise<MicroSandboxInstance>;
}

export interface MicrosandboxDeps {
  logger: Logger;
  client?: MicrosandboxClient;
  ready?: ReadyProbe;
  /** Host port to publish to; defaults to the guest port. Tests/parallel runs can inject a free port. */
  hostPort?: number;
}

// START_CONTRACT: createMicrosandbox
//   PURPOSE: Provision a microVM sandbox, start opencode serve, and return a SandboxHandle with a reachable endpoint.
//   INPUTS: { spec: SandboxSpec, deps: MicrosandboxDeps }
//   OUTPUTS: { Promise<SandboxHandle> }
//   SIDE_EFFECTS: boots a microVM and a long-lived serve process; logs policy/teardown
//   LINKS: M-SANDBOX, V-M-SANDBOX, SANDBOX_PROVISION_FAILED
// END_CONTRACT: createMicrosandbox
export async function createMicrosandbox(spec: SandboxSpec, deps: MicrosandboxDeps): Promise<SandboxHandle> {
  const { logger } = deps;
  const client = deps.client ?? createRealMicrosandboxClient();
  const ready = deps.ready ?? defaultReadyProbe;
  const guestPort = spec.publishPort ?? DEFAULT_GUEST_PORT;
  const hostPort = deps.hostPort ?? guestPort;
  const vacuum = spec.networkMode === "vacuum";
  const name = `agent-lab-${hostPort}`;

  // START_BLOCK_APPLY_NETWORK_POLICY
  logger.info(
    { marker: "BLOCK_APPLY_NETWORK_POLICY", backend: "microsandbox", networkMode: vacuum ? "vacuum" : "open", allowlistSize: spec.networkAllowlist.length },
    "[Sandbox][createMicrosandbox][BLOCK_APPLY_NETWORK_POLICY] applying network policy",
  );

  let instance: MicroSandboxInstance;
  try {
    instance = await client.create({
      name,
      image: spec.image,
      hostPort,
      guestPort,
      vacuum,
      allowlist: vacuum ? [...new Set([...spec.networkAllowlist, ...VACUUM_BASE_HOSTS])] : [],
      mounts: (spec.mounts ?? []).map((m) => ({ host: m.source, guest: m.target, readonly: m.readonly ?? false })),
    });
  } catch (err) {
    logger.error({ marker: "BLOCK_APPLY_NETWORK_POLICY", backend: "microsandbox" }, "[Sandbox][createMicrosandbox][BLOCK_APPLY_NETWORK_POLICY] provision failed");
    throw new SandboxError(SANDBOX_PROVISION_FAILED, "failed to provision microsandbox microVM", err);
  }
  // END_BLOCK_APPLY_NETWORK_POLICY

  // Start opencode serve as a long-lived process (no ENTRYPOINT auto-run in microsandbox).
  let serve: MicroProcess;
  try {
    serve = await instance.execStream("opencode", ["serve", "--hostname", "0.0.0.0", "--port", String(guestPort)]);
  } catch (err) {
    await instance.stop().catch(() => {});
    throw new SandboxError(SANDBOX_PROVISION_FAILED, "failed to start opencode serve in microVM", err);
  }

  // START_BLOCK_WAIT_READY
  const endpoint = `http://127.0.0.1:${hostPort}`;
  try {
    await ready(endpoint);
    logger.info({ marker: "BLOCK_WAIT_READY", sandboxId: name, endpoint }, "[Sandbox][createMicrosandbox][BLOCK_WAIT_READY] endpoint ready");
  } catch (err) {
    await serve.kill().catch(() => {});
    await instance.stop().catch(() => {});
    logger.error({ marker: "BLOCK_WAIT_READY", sandboxId: name }, "[Sandbox][createMicrosandbox][BLOCK_WAIT_READY] endpoint not ready");
    throw new SandboxError(SANDBOX_PROVISION_FAILED, "microsandbox endpoint did not become ready", err);
  }
  // END_BLOCK_WAIT_READY

  let disposed = false;
  return {
    sandboxId: name,
    endpoint,
    async exec(cmd: string[]) {
      const [bin, ...args] = cmd;
      const res = await instance.exec(bin ?? "", args);
      return { stdout: res.stdout(), stderr: res.stderr(), exitCode: res.code };
    },
    async dispose() {
      // START_BLOCK_TEARDOWN
      if (disposed) return;
      disposed = true;
      await serve.kill().catch(() => {});
      await instance.stop();
      logger.info({ marker: "BLOCK_TEARDOWN", sandboxId: name, backend: "microsandbox" }, "[Sandbox][createMicrosandbox][BLOCK_TEARDOWN] disposed");
      // END_BLOCK_TEARDOWN
    },
  };
}

// START_CONTRACT: createRealMicrosandboxClient
//   PURPOSE: Build a MicrosandboxClient backed by the real microsandbox SDK (lazy-loaded native libkrun binding).
//   INPUTS: {}
//   OUTPUTS: { MicrosandboxClient }
//   SIDE_EFFECTS: dynamically imports the microsandbox SDK on first create(); boots a microVM when used
//   LINKS: M-SANDBOX
// END_CONTRACT: createRealMicrosandboxClient
export function createRealMicrosandboxClient(): MicrosandboxClient {
  return {
    async create(opts: MicroCreateOptions): Promise<MicroSandboxInstance> {
      // Lazy import so tests and the Docker path never load the native binding / require the libkrun runtime.
      const msb = (await import("microsandbox")) as unknown as MsbModule;
      const { Sandbox, NetworkPolicy } = msb;

      let builder = Sandbox.builder(opts.name).image(opts.image);
      for (const m of opts.mounts) {
        // MountBuilder(guestPath).host(hostPath) — read-only where supported.
        builder = builder.mount(m.guest, (mb) => (m.readonly ? mb.host(m.host).readonly() : mb.host(m.host)));
      }
      builder = builder.network((n) => {
        let nb = n.port(opts.hostPort, opts.guestPort);
        if (opts.vacuum) {
          const policy = NetworkPolicy.builder()
            .defaultDeny()
            .rule((r) => r.allowDns())
            .rule((r) => r.allowDomains(opts.allowlist))
            .build();
          nb = nb.policy(policy);
        }
        return nb;
      });

      const sb = await builder.create();
      return {
        execStream: (cmd, args) => sb.execStream(cmd, args) as Promise<MicroProcess>,
        exec: (cmd, args) => sb.exec(cmd, args) as Promise<MicroExecResult>,
        stop: () => sb.stop(),
      };
    },
  };
}

/** Minimal structural view of the microsandbox SDK surface we use (keeps this file typecheckable without SDK types). */
interface MsbModule {
  Sandbox: { builder(name: string): MsbBuilder };
  NetworkPolicy: { builder(): MsbPolicyBuilder };
}
interface MsbBuilder {
  image(src: string): MsbBuilder;
  mount(guest: string, fn: (mb: MsbMountBuilder) => MsbMountBuilder): MsbBuilder;
  network(fn: (n: MsbNetworkBuilder) => MsbNetworkBuilder): MsbBuilder;
  create(): Promise<MsbSandbox>;
}
interface MsbMountBuilder {
  host(path: string): MsbMountBuilder;
  readonly(): MsbMountBuilder;
}
interface MsbNetworkBuilder {
  port(host: number, guest: number): MsbNetworkBuilder;
  policy(p: unknown): MsbNetworkBuilder;
}
interface MsbPolicyBuilder {
  defaultDeny(): MsbPolicyBuilder;
  rule(fn: (r: MsbRuleBuilder) => MsbRuleBuilder): MsbPolicyBuilder;
  build(): unknown;
}
interface MsbRuleBuilder {
  allowDns(): MsbRuleBuilder;
  allowDomains(names: string[]): MsbRuleBuilder;
}
interface MsbSandbox {
  execStream(cmd: string, args: string[]): Promise<unknown>;
  exec(cmd: string, args: string[]): Promise<unknown>;
  stop(): Promise<void>;
}

// --- private helpers ---

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
