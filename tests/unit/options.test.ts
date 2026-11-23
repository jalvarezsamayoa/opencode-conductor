import { describe, expect, it } from "vitest";
import {
    formatModelRef,
    parseConductorOptions,
    parseModelRef,
} from "../../src/config/options.js";

describe("parseModelRef and formatModelRef", () => {
    it("parses provider/model string shorthand", () => {
        expect(parseModelRef("google/gemini-4-hydrogen")).toEqual({
            providerID: "google",
            id: "gemini-4-hydrogen",
        });
    });

    it("preserves slashes inside model id and parses optional variant", () => {
        const parsed = parseModelRef("openrouter/anthropic/claude-3.5-sonnet#high");
        expect(parsed).toEqual({
            providerID: "openrouter",
            id: "anthropic/claude-3.5-sonnet",
            variant: "high",
        });
        expect(formatModelRef(parsed)).toBe("openrouter/anthropic/claude-3.5-sonnet#high");
    });

    it("formats model ref without variant cleanly", () => {
        expect(formatModelRef({ providerID: "google", id: "gemini-4-neon" })).toBe(
            "google/gemini-4-neon",
        );
    });

    it("rejects invalid model reference syntax including whitespace and control characters", () => {
        const invalidInputs = [
            "",
            "noslash",
            "/missing-provider",
            "google/",
            "bad#prov/model",
            "google/model#",
            "google/model#a#b",
            "google/bad model",
            "google/bad\nmodel",
            "google/bad\u0007model",
        ];
        for (const candidate of invalidInputs) {
            expect(() => parseModelRef(candidate)).toThrow();
        }
    });
});

describe("parseConductorOptions", () => {
    it("returns safe defaults when input is undefined or empty", () => {
        expect(parseConductorOptions(undefined)).toEqual({
            maxConsecutiveFailures: 3,
            blockedPlanTools: ["write", "edit", "patch", "execute"],
            promptShellInPlanMode: true,
        });
    });

    it("parses object and string shorthand models and ignores unknown keys", () => {
        const result = parseConductorOptions({
            planner: { providerID: "anthropic", id: "claude-opus-4", variant: "high" },
            executor: "google/gemini-4-hydrogen",
            maxConsecutiveFailures: 4,
            blockedPlanTools: ["write", "edit"],
            promptShellInPlanMode: false,
            unrelatedKey: "ignored",
        });
        expect(result).toEqual({
            planner: { providerID: "anthropic", id: "claude-opus-4", variant: "high" },
            executor: { providerID: "google", id: "gemini-4-hydrogen" },
            maxConsecutiveFailures: 4,
            blockedPlanTools: ["write", "edit"],
            promptShellInPlanMode: false,
        });
    });

    it("falls back tolerantly on invalid optional fields and surfaces configWarning for invalid models", () => {
        const result = parseConductorOptions({
            planner: "invalid-model",
            executor: { providerID: "", id: "bad" },
            maxConsecutiveFailures: 0,
            blockedPlanTools: [123],
            promptShellInPlanMode: "yes",
        });
        expect(result.planner).toBeUndefined();
        expect(result.executor).toBeUndefined();
        expect(result.maxConsecutiveFailures).toBe(3);
        expect(result.blockedPlanTools).toEqual(["write", "edit", "patch", "execute"]);
        expect(result.promptShellInPlanMode).toBe(true);
        expect(result.configWarning).toContain("planner");
        expect(result.configWarning).toContain("executor");
    });
});
