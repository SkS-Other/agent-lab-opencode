// FILE: src/sandbox/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-SANDBOX provisioning, network-policy build, guaranteed teardown, and failure handling on a fake engine.
//   SCOPE: buildRunArgs policy, createSandbox success/failure, dispose idempotence, withSandbox teardown guarantee, markers
//   DEPENDS: M-SANDBOX, M-LOGGER
//   LINKS: V-M-SANDBOX, VF-003, VF-004
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   collectLines - in-memory pino destination capturing markers + raw text
//   makeDeps - build SandboxDeps with a real capture logger and a fake engine
//   fakeEngine - DockerEngine fake recording run/exec/remove calls
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-SANDBOX tests (policy, lifecycle, teardown guarantee, failures).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger/index.ts";
import {
  buildRunArgs,
  createSandbox,
  SANDBOX_PROVISION_FAILED,
  SANDBOX_TEARDOWN_FAILED,
  SandboxError,
  withSandbox,
  type DockerEngine,
  type SandboxSpec,
} from "./index.ts";

function collectLines() {
  const objects: Array<Record<string, unknown>> = [];
  let raw = "";
  const dest = {
    write(s: string) {
      raw += s;
      for (const line of s.split("\n")) if (line.trim()) objects.push(JSON.parse(line));
    },
  };
  return {
    dest,
    objects,
    markers: () => objects.map((o) => o.marker).filter(Boolean) as string[],
    get raw() {
      return raw;
    },
  };
}

interface FakeCalls {
  run: string[][];
  exec: Array<{ id: string; cmd: string[] }>;
  remove: string[];
}

function fakeEngine(opts: { failRun?: boolean; failRemove?: boolean } = {}): {
  engine: DockerEngine;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { run: [], exec: [], remove: [] };
  const engine: DockerEngine = {
    async run(args) {
      calls.run.push(args);
      if (opts.failRun) throw new Error("docker run boom");
      return { containerId: "fake-container-123" };
    },
    async exec(id, cmd) {
      calls.exec.push({ id, cmd });
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async remove(id) {
      calls.remove.push(id);
      if (opts.failRemove) throw new Error("docker rm boom");
    },
  };
  return { engine, calls };
}

const spec: SandboxSpec = {
  image: "agent-lab-opencode:latest",
  networkAllowlist: ["api.anthropic.com"],
  env: { ANTHROPIC_API_KEY: "sk-secret" },
  resourceLimits: { cpus: 2, memoryMb: 1024 },
};

describe("buildRunArgs", () => {
  // VF-003: empty allowlist => full network vacuum
  test("uses --network none when the allowlist is empty", () => {
    const args = buildRunArgs({ image: "x", networkAllowlist: [] });
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  test("uses bridge + allow labels when the allowlist is non-empty", () => {
    const args = buildRunArgs(spec);
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
    expect(args).toContain("--label");
    expect(args.some((a) => a === "agent-lab.allow=api.anthropic.com")).toBe(true);
  });

  test("reflects resource limits, env, and image position", () => {
    const args = buildRunArgs(spec);
    expect(args).toContain("--cpus");
    expect(args).toContain("--memory");
    expect(args).toContain("1024m");
    expect(args).toContain("ANTHROPIC_API_KEY=sk-secret");
    expect(args.at(-1)).toBe("agent-lab-opencode:latest"); // image last (no entrypoint)
  });
});

describe("createSandbox", () => {
  // scenario-1 (success)
  test("provisions a container and execs through the engine", async () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, level: "debug" });
    const { engine, calls } = fakeEngine();

    const handle = await createSandbox(spec, { logger, engine });
    expect(handle.sandboxId).toBe("fake-container-123");
    expect(calls.run).toHaveLength(1);

    const res = await handle.exec(["echo", "hi"]);
    expect(res.exitCode).toBe(0);
    expect(calls.exec[0]?.cmd).toEqual(["echo", "hi"]);

    await handle.dispose();
    expect(calls.remove).toEqual(["fake-container-123"]);
    expect(sink.markers()).toContain("BLOCK_APPLY_NETWORK_POLICY");
    expect(sink.markers()).toContain("BLOCK_TEARDOWN");
  });

  // secret must not leak into logs even though it is in spec.env
  test("does not leak the injected api key into logs", async () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, level: "debug" });
    const { engine } = fakeEngine();
    const handle = await createSandbox(spec, { logger, engine });
    await handle.dispose();
    expect(sink.raw).not.toContain("sk-secret");
  });

  // scenario-2 (failure): provision fails, nothing leaks
  test("surfaces SANDBOX_PROVISION_FAILED and returns no handle / logs no container id", async () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, level: "debug" });
    const { engine, calls } = fakeEngine({ failRun: true });

    let handle: unknown = "none";
    try {
      handle = await createSandbox(spec, { logger, engine });
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe(SANDBOX_PROVISION_FAILED);
    }
    expect(handle).toBe("none");
    expect(calls.remove).toHaveLength(0); // nothing to clean up
    expect(sink.raw).not.toContain("fake-container-123");
  });

  test("dispose is idempotent (remove called once)", async () => {
    const logger = createLogger({ level: "silent" });
    const { engine, calls } = fakeEngine();
    const handle = await createSandbox(spec, { logger, engine });
    await handle.dispose();
    await handle.dispose();
    expect(calls.remove).toHaveLength(1);
  });

  test("surfaces SANDBOX_TEARDOWN_FAILED when remove fails", async () => {
    const logger = createLogger({ level: "silent" });
    const { engine } = fakeEngine({ failRemove: true });
    const handle = await createSandbox(spec, { logger, engine });
    await expect(handle.dispose()).rejects.toThrow(SandboxError);
  });
});

describe("withSandbox", () => {
  // VF-004: teardown runs even when fn throws
  test("disposes the sandbox even when the body throws", async () => {
    const logger = createLogger({ level: "silent" });
    const { engine, calls } = fakeEngine();

    await expect(
      withSandbox(spec, { logger, engine }, async () => {
        throw new Error("body failed mid-flight");
      }),
    ).rejects.toThrow("body failed mid-flight");

    expect(calls.remove).toEqual(["fake-container-123"]); // teardown still happened
  });

  test("returns the body result and disposes on success", async () => {
    const logger = createLogger({ level: "silent" });
    const { engine, calls } = fakeEngine();
    const out = await withSandbox(spec, { logger, engine }, async (h) => {
      await h.exec(["true"]);
      return "result";
    });
    expect(out).toBe("result");
    expect(calls.remove).toHaveLength(1);
  });
});
