import { describe, expect, it } from "vitest";
import {
    evaluateShellPermission,
    evaluateToolAccess,
    filterToolsForContext,
} from "../../src/core/tool-guard.js";
import type { EnabledConductorState, SessionConductorState } from "../../src/core/types.js";

const BLOCKED_SET = new Set(["write", "edit", "patch", "execute"]);

const BASE_ENABLED: EnabledConductorState = {
    enabled: true,
    paused: false,
    phase: "PLANNING",
    phaseEpoch: 1,
    plannerModel: { providerID: "google", id: "gemini-4-neon" },
    executorModel: { providerID: "google", id: "gemini-4-hydrogen" },
    consecutiveToolFailures: 0,
    autoHandbacksThisTurn: 0,
};

function makeToolMap() {
    return {
        read: { description: "read", input: {} },
        glob: { description: "glob", input: {} },
        write: { description: "write", input: {} },
        edit: { description: "edit", input: {} },
        patch: { description: "patch", input: {} },
        execute: { description: "execute", input: {} },
        shell: { description: "shell", input: {} },
        exit_plan_mode: { description: "exit", input: {} },
        enter_plan_mode: { description: "enter", input: {} },
    };
}

describe("evaluateToolAccess and filterToolsForContext", () => {
    it("strips and blocks only Conductor tools when disabled", () => {
        const disabledState: SessionConductorState = { enabled: false };
        const filtered = filterToolsForContext(disabledState, makeToolMap(), BLOCKED_SET);

        expect(Object.keys(filtered)).not.toContain("exit_plan_mode");
        expect(Object.keys(filtered)).not.toContain("enter_plan_mode");
        expect(Object.keys(filtered)).toEqual(
            expect.arrayContaining(["read", "write", "edit", "patch", "execute", "shell"]),
        );
        expect(evaluateToolAccess(disabledState, "write", false, BLOCKED_SET).allowed).toBe(true);
        expect(evaluateToolAccess(disabledState, "exit_plan_mode", false, BLOCKED_SET).allowed).toBe(false);
        expect(evaluateToolAccess(disabledState, "enter_plan_mode", false, BLOCKED_SET).allowed).toBe(false);
    });

    it("strips and blocks only Conductor tools when paused", () => {
        const pausedState: EnabledConductorState = { ...BASE_ENABLED, phase: "EXECUTING", paused: true };
        const filtered = filterToolsForContext(pausedState, makeToolMap(), BLOCKED_SET);

        expect(Object.keys(filtered)).not.toContain("exit_plan_mode");
        expect(Object.keys(filtered)).not.toContain("enter_plan_mode");
        expect(evaluateToolAccess(pausedState, "write", false, BLOCKED_SET).allowed).toBe(true);
        expect(evaluateToolAccess(pausedState, "exit_plan_mode", false, BLOCKED_SET).allowed).toBe(false);
    });

    it("blocks mutating tools, enter_plan_mode, and codemode during PLANNING", () => {
        const filtered = filterToolsForContext(BASE_ENABLED, makeToolMap(), BLOCKED_SET);

        expect(Object.keys(filtered)).toEqual(["read", "glob", "shell", "exit_plan_mode"]);
        expect(evaluateToolAccess(BASE_ENABLED, "read", false, BLOCKED_SET).allowed).toBe(true);
        expect(evaluateToolAccess(BASE_ENABLED, "exit_plan_mode", false, BLOCKED_SET).allowed).toBe(true);
        expect(evaluateToolAccess(BASE_ENABLED, "write", false, BLOCKED_SET).allowed).toBe(false);
        expect(evaluateToolAccess(BASE_ENABLED, "enter_plan_mode", false, BLOCKED_SET).allowed).toBe(false);
        expect(evaluateToolAccess(BASE_ENABLED, "read", true, BLOCKED_SET).allowed).toBe(false);
    });

    it("unlocks mutating tools and blocks exit_plan_mode during EXECUTING", () => {
        const executingState: EnabledConductorState = { ...BASE_ENABLED, phase: "EXECUTING" };
        const filtered = filterToolsForContext(executingState, makeToolMap(), BLOCKED_SET);

        expect(Object.keys(filtered)).not.toContain("exit_plan_mode");
        expect(Object.keys(filtered)).toEqual(
            expect.arrayContaining(["read", "write", "edit", "patch", "execute", "enter_plan_mode"]),
        );
        expect(evaluateToolAccess(executingState, "write", false, BLOCKED_SET).allowed).toBe(true);
        expect(evaluateToolAccess(executingState, "enter_plan_mode", false, BLOCKED_SET).allowed).toBe(true);
        expect(evaluateToolAccess(executingState, "exit_plan_mode", false, BLOCKED_SET).allowed).toBe(false);
    });
});

describe("evaluateShellPermission", () => {
    it("downgrades allow to ask for shell during PLANNING when enabled and configured", () => {
        expect(evaluateShellPermission(BASE_ENABLED, "shell", "allow", true)).toBe("ask");
    });

    it("strictly preserves deny and existing ask rules", () => {
        expect(evaluateShellPermission(BASE_ENABLED, "shell", "deny", true)).toBe("deny");
        expect(evaluateShellPermission(BASE_ENABLED, "shell", "ask", true)).toBe("ask");
    });

    it("leaves allow unchanged when disabled, paused, executing, non-shell, or promptShellInPlanMode is false", () => {
        expect(evaluateShellPermission({ enabled: false }, "shell", "allow", true)).toBe("allow");
        expect(evaluateShellPermission({ ...BASE_ENABLED, paused: true }, "shell", "allow", true)).toBe("allow");
        expect(evaluateShellPermission({ ...BASE_ENABLED, phase: "EXECUTING" }, "shell", "allow", true)).toBe("allow");
        expect(evaluateShellPermission(BASE_ENABLED, "read", "allow", true)).toBe("allow");
        expect(evaluateShellPermission(BASE_ENABLED, "shell", "allow", false)).toBe("allow");
    });
});
