// FILE: src/logger/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-LOGGER marker bindings, secret redaction, and the BLOCK_REDACT_FIELDS marker.
//   SCOPE: bindings appear; secret-shaped fields never appear verbatim; redaction marker emitted
//   DEPENDS: M-LOGGER
//   LINKS: V-M-LOGGER
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   collectLines - in-memory pino destination capturing parsed log objects
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-LOGGER tests (bindings, redaction, marker).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLogger, REDACTED_VALUE } from "./index.ts";

/** In-memory destination: captures each emitted line as a parsed object plus raw text. */
function collectLines(): { dest: { write(s: string): void }; objects: Array<Record<string, unknown>>; raw: string } {
  const objects: Array<Record<string, unknown>> = [];
  let raw = "";
  const dest = {
    write(s: string): void {
      raw += s;
      for (const line of s.split("\n")) {
        if (line.trim() === "") continue;
        objects.push(JSON.parse(line) as Record<string, unknown>);
      }
    },
  };
  return {
    dest,
    objects,
    get raw() {
      return raw;
    },
  };
}

describe("createLogger", () => {
  // scenario-1 (success): marker bindings appear in structured output
  test("binds marker fields (runId, sandboxId) onto every line", () => {
    const sink = collectLines();
    const logger = createLogger({ bindings: { runId: "run-1", sandboxId: "sbx-1" }, destination: sink.dest });
    logger.info({ marker: "BLOCK_DEMO" }, "hello");

    const line = sink.objects.find((o) => o.marker === "BLOCK_DEMO");
    expect(line).toBeDefined();
    expect(line?.runId).toBe("run-1");
    expect(line?.sandboxId).toBe("sbx-1");
  });

  test("omits empty bindings", () => {
    const sink = collectLines();
    const logger = createLogger({ bindings: { runId: "", correlationId: "c-9" }, destination: sink.dest });
    logger.info("x");
    const line = sink.objects.at(-1);
    expect(line?.correlationId).toBe("c-9");
    expect(line && "runId" in line).toBe(false);
  });

  // scenario-2 (failure mode for secrets): secret-shaped fields are redacted, never verbatim
  test("redacts secret-shaped fields and never emits the raw value", () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest });
    logger.info({ apiKey: "sk-super-secret-123", token: "tok-abc", nested: { secret: "hunter2" } }, "auth");

    expect(sink.raw).not.toContain("sk-super-secret-123");
    expect(sink.raw).not.toContain("tok-abc");
    expect(sink.raw).not.toContain("hunter2");

    const line = sink.objects.find((o) => o.msg === "auth");
    expect(line?.apiKey).toBe(REDACTED_VALUE);
    expect(line?.token).toBe(REDACTED_VALUE);
  });

  test("honors extra redaction paths", () => {
    const sink = collectLines();
    const logger = createLogger({ destination: sink.dest, redactPaths: ["customField"] });
    logger.info({ customField: "leak-me" }, "x");
    expect(sink.raw).not.toContain("leak-me");
  });

  // required log marker
  test("emits BLOCK_REDACT_FIELDS marker at debug level", () => {
    const sink = collectLines();
    createLogger({ destination: sink.dest, level: "debug" });
    const marker = sink.objects.find((o) => o.marker === "BLOCK_REDACT_FIELDS");
    expect(marker).toBeDefined();
    expect(typeof marker?.redactPathCount).toBe("number");
  });
});
