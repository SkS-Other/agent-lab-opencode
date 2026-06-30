// FILE: src/config/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify M-CONFIG validation, defaults, matrix expansion, and the BLOCK_VALIDATE_INPUT marker.
//   SCOPE: loadExperiment success/failure, no-partial-on-error, expandMatrix cartesian product, log marker
//   DEPENDS: M-CONFIG
//   LINKS: V-M-CONFIG
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   captureLogger - fake GraceLogger that records emitted markers
//   validInput - minimal valid raw experiment definition fixture
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: v1.0.0 - Initial M-CONFIG tests (validation, defaults, matrix, markers).
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  CONFIG_INVALID_INPUT,
  ConfigError,
  expandMatrix,
  loadExperiment,
  type ExperimentMatrix,
  type GraceLogger,
} from "./index.ts";

function captureLogger(): { logger: GraceLogger; markers: string[] } {
  const markers: string[] = [];
  const record = (obj: object) => {
    const marker = (obj as { marker?: string }).marker;
    if (marker) markers.push(marker);
  };
  const logger: GraceLogger = { debug: record, info: record, warn: record, error: record };
  return { logger, markers };
}

const validInput = {
  systemPrompt: "You are a careful agent.",
  model: "anthropic/claude-opus-4-8",
  taskPrompt: "Refactor the parser.",
};

describe("loadExperiment", () => {
  // scenario-1 (success)
  test("parses a valid definition and applies sandbox defaults", () => {
    const def = loadExperiment(validInput);
    expect(def.systemPrompt).toBe(validInput.systemPrompt);
    expect(def.model).toBe(validInput.model);
    expect(def.taskPrompt).toBe(validInput.taskPrompt);
    expect(def.name.length).toBeGreaterThan(0);
    expect(def.sandbox.image).toBe("agent-lab-opencode:latest");
    expect(def.sandbox.timeoutMs).toBe(300_000);
    expect(def.sandbox.networkAllowlist).toEqual([]);
  });

  test("accepts explicit sandbox options", () => {
    const def = loadExperiment({
      ...validInput,
      sandbox: { image: "custom:1", networkAllowlist: ["api.anthropic.com"], timeoutMs: 60_000 },
    });
    expect(def.sandbox.image).toBe("custom:1");
    expect(def.sandbox.networkAllowlist).toEqual(["api.anthropic.com"]);
    expect(def.sandbox.timeoutMs).toBe(60_000);
  });

  // scenario-2 (failure)
  test("rejects a missing model with CONFIG_INVALID_INPUT", () => {
    const { model, ...noModel } = validInput;
    expect(() => loadExperiment(noModel)).toThrow(ConfigError);
    try {
      loadExperiment(noModel);
    } catch (err) {
      expect((err as ConfigError).code).toBe(CONFIG_INVALID_INPUT);
    }
  });

  test("rejects an empty taskPrompt", () => {
    expect(() => loadExperiment({ ...validInput, taskPrompt: "   " })).toThrow(ConfigError);
  });

  test("rejects non-object input", () => {
    expect(() => loadExperiment(null)).toThrow(ConfigError);
    expect(() => loadExperiment([validInput])).toThrow(ConfigError);
  });

  test("rejects invalid sandbox timeout", () => {
    expect(() =>
      loadExperiment({ ...validInput, sandbox: { timeoutMs: -1 } }),
    ).toThrow(ConfigError);
  });

  // no-partial-on-error invariant
  test("never returns a partial definition on error", () => {
    let returned: unknown = "sentinel";
    try {
      returned = loadExperiment({ systemPrompt: "x" }); // missing model + taskPrompt
    } catch {
      // expected
    }
    expect(returned).toBe("sentinel"); // assignment never happened
  });

  // required log marker
  test("emits BLOCK_VALIDATE_INPUT marker", () => {
    const { logger, markers } = captureLogger();
    loadExperiment(validInput, logger);
    expect(markers).toContain("BLOCK_VALIDATE_INPUT");
  });
});

describe("expandMatrix", () => {
  const base = { ...validInput };

  test("expands the cartesian product of variation axes", () => {
    const matrix: ExperimentMatrix = {
      base,
      variations: {
        model: ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6"],
        systemPrompt: ["prompt A", "prompt B"],
      },
    };
    const defs = expandMatrix(matrix);
    expect(defs).toHaveLength(4); // 2 models x 2 systemPrompts x 1 taskPrompt
    const names = new Set(defs.map((d) => d.name));
    expect(names.size).toBe(4); // names disambiguated
  });

  test("returns one definition when no variations are given", () => {
    const defs = expandMatrix({ base });
    expect(defs).toHaveLength(1);
  });

  test("each expanded definition is fully validated", () => {
    const defs = expandMatrix({ base, variations: { model: ["a/b", "c/d"] } });
    for (const def of defs) {
      expect(def.sandbox.timeoutMs).toBeGreaterThan(0);
      expect(def.taskPrompt).toBe(base.taskPrompt);
    }
  });

  test("rejects an empty variation axis", () => {
    expect(() => expandMatrix({ base, variations: { model: [] } })).toThrow(ConfigError);
  });

  test("emits BLOCK_EXPAND_MATRIX marker", () => {
    const { logger, markers } = captureLogger();
    expandMatrix({ base }, logger);
    expect(markers).toContain("BLOCK_EXPAND_MATRIX");
  });
});
