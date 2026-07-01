// FILE: src/sandbox/microsandbox.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the microsandbox backend lifecycle (provision, serve, readiness, exec, guaranteed teardown) on a fake client.
//   SCOPE: createMicrosandbox success/provision-fail/serve-fail/ready-fail, dispose idempotence, vacuum allowlist, markers
//   DEPENDS: M-SANDBOX, M-LOGGER
//   LINKS: V-M-SANDBOX
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   collectLines - capture pino markers
//   fakeClient - injectable MicrosandboxClient fake recording create/serve/stop/kill
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial microsandbox backend tests (lifecycle, teardown, vacuum allowlist).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger/index.ts";
import { SANDBOX_PROVISION_FAILED, SandboxError, type SandboxSpec } from "./index.ts";
import { createMicrosandbox, type MicroCreateOptions, type MicrosandboxClient } from "./microsandbox.ts";

function collectLines() {
  const objects: Array<Record<string, unknown>> = [];
  const dest = {
    write(s: string) {
      for (const line of s.split("\n")) if (line.trim()) objects.push(JSON.parse(line));
    },
  };
  return { dest, markers: () => objects.map((o) => o.marker).filter(Boolean) as string[] };
}

interface Calls {
  create: MicroCreateOptions[];
  serve: number;
  stop: number;
  kill: number;
}

function fakeClient(opts: { failCreate?: boolean; failServe?: boolean } = {}): { client: MicrosandboxClient; calls: Calls } {
  const calls: Calls = { create: [], serve: 0, stop: 0, kill: 0 };
  const instance = {
    async execStream() {
      calls.serve++;
      if (opts.failServe) throw new Error("serve boom");
      return { kill: async () => { calls.kill++; } };
    },
    async exec(_cmd: string, _args: string[]) {
      return { stdout: () => "out", stderr: () => "", code: 0 };
    },
    async stop() {
      calls.stop++;
    },
  };
  const client: MicrosandboxClient = {
    async create(o) {
      calls.create.push(o);
      if (opts.failCreate) throw new Error("create boom");
      return instance;
    },
  };
  return { client, calls };
}

const spec: SandboxSpec = {
  image: "agent-lab-opencode:latest",
  backend: "microsandbox",
  networkAllowlist: ["cpa.funxyz.fun"],
  publishPort: 4096,
};

describe("createMicrosandbox", () => {
  test("provisions a microVM, starts serve, resolves an endpoint, and execs", async () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, level: "debug" });
    const { client, calls } = fakeClient();
    const ready = async () => {};

    const handle = await createMicrosandbox(spec, { logger, client, ready, hostPort: 4096 });
    expect(handle.endpoint).toBe("http://127.0.0.1:4096");
    expect(calls.create).toHaveLength(1);
    expect(calls.serve).toBe(1);

    const res = await handle.exec(["echo", "hi"]);
    expect(res).toEqual({ stdout: "out", stderr: "", exitCode: 0 });

    expect(sink.markers()).toContain("BLOCK_APPLY_NETWORK_POLICY");
    expect(sink.markers()).toContain("BLOCK_WAIT_READY");

    await handle.dispose();
    expect(calls.kill).toBe(1);
    expect(calls.stop).toBe(1);
    expect(sink.markers()).toContain("BLOCK_TEARDOWN");
  });

  test("vacuum mode passes the allowlist plus opencode base hosts", async () => {
    const logger = createLogger({ level: "silent" });
    const { client, calls } = fakeClient();
    await createMicrosandbox(
      { ...spec, networkMode: "vacuum" },
      { logger, client, ready: async () => {}, hostPort: 4096 },
    );
    const allow = calls.create[0]?.allowlist ?? [];
    expect(allow).toContain("cpa.funxyz.fun");
    expect(allow).toContain("models.dev");
    expect(calls.create[0]?.vacuum).toBe(true);
  });

  test("surfaces SANDBOX_PROVISION_FAILED when the microVM cannot be created", async () => {
    const logger = createLogger({ level: "silent" });
    const { client } = fakeClient({ failCreate: true });
    await expect(createMicrosandbox(spec, { logger, client, ready: async () => {} })).rejects.toMatchObject({
      code: SANDBOX_PROVISION_FAILED,
    });
  });

  test("stops the microVM if serve fails to start (no leak)", async () => {
    const logger = createLogger({ level: "silent" });
    const { client, calls } = fakeClient({ failServe: true });
    await expect(createMicrosandbox(spec, { logger, client, ready: async () => {} })).rejects.toBeInstanceOf(SandboxError);
    expect(calls.stop).toBe(1);
  });

  test("kills serve and stops the microVM if the endpoint never becomes ready", async () => {
    const logger = createLogger({ level: "silent" });
    const { client, calls } = fakeClient();
    const ready = async () => { throw new Error("never ready"); };
    await expect(createMicrosandbox(spec, { logger, client, ready })).rejects.toMatchObject({
      code: SANDBOX_PROVISION_FAILED,
    });
    expect(calls.kill).toBe(1);
    expect(calls.stop).toBe(1);
  });

  test("dispose is idempotent", async () => {
    const logger = createLogger({ level: "silent" });
    const { client, calls } = fakeClient();
    const handle = await createMicrosandbox(spec, { logger, client, ready: async () => {}, hostPort: 4096 });
    await handle.dispose();
    await handle.dispose();
    expect(calls.stop).toBe(1);
  });
});
