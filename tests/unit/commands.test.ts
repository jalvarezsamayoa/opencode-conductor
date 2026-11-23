import { describe, expect, it, vi } from "vitest";
import {
    executeConductorCommand,
    parseConductorCommandArgs,
    type ConductorCommandHost,
} from "../../src/commands/conductor-command.js";
import { parseConductorOptions } from "../../src/config/options.js";
import { ConductorStateStore, type JsonValue, type StorageBackend } from "../../src/core/state-store.js";
import type { ModelRef } from "../../src/core/types.js";
import { createEnterPlanModeTool, EnterPlanModeSchema } from "../../src/tools/enter-plan-mode.js";
import { createExitPlanModeTool, ExitPlanModeSchema } from "../../src/tools/exit-plan-mode.js";

const PLANNER: ModelRef = { providerID: "google", id: "gemini-4-neon" };
const EXECUTOR: ModelRef = { providerID: "google", id: "gemini-4-hydrogen" };

function createInMemoryStorage(): StorageBackend {
    const map = new Map<string, JsonValue>();
    return {
        get: async (key) => map.get(key),
        set: async (key, value) => { map.set(key, value); },
        remove: async (key) => { map.delete(key); },
        scan: async () => ({ entries: [...map.entries()].map(([key, value]) => ({ key, value })) }),
    };
}

function createHostHarness(sessionModel: ModelRef | undefined) {
    const store = new ConductorStateStore(createInMemoryStorage());
    const syntheticCalls: Array<unknown> = [];
    const switchCalls: Array<unknown> = [];
    const host: ConductorCommandHost = {
        getSessionModel: vi.fn(async () => sessionModel),
        switchModel: vi.fn(async (sessionID, model) => { switchCalls.push({ sessionID, model }); }),
        sendNotice: vi.fn(async (sessionID, text) => { syntheticCalls.push({ sessionID, text }); }),
    };
    return { store, host, syntheticCalls, switchCalls };
}

describe("parseConductorCommandArgs", () => {
    it("normalizes optional /conductor prefix and handles subcommands", () => {
        expect(parseConductorCommandArgs("")).toEqual({ kind: "status" });
        expect(parseConductorCommandArgs("/conductor status")).toEqual({ kind: "status" });
        expect(parseConductorCommandArgs("/CONDUCTOR on")).toEqual({ kind: "on" });
        expect(parseConductorCommandArgs("off")).toEqual({ kind: "off" });
        expect(parseConductorCommandArgs("google/gemini-4-hydrogen#fast")).toEqual({
            kind: "set_executor",
            model: { providerID: "google", id: "gemini-4-hydrogen", variant: "fast" },
        });
        expect(parseConductorCommandArgs("unknown-arg")).toEqual({ kind: "unknown" });
    });
});

describe("executeConductorCommand", () => {
    it("fails fast on /conductor on when executor or session planner model is missing", async () => {
        const { store, host } = createHostHarness(PLANNER);
        await executeConductorCommand("s1", "on", parseConductorOptions({}), store, host);
        expect(store.get("s1").enabled).toBe(false);
        expect(host.sendNotice).toHaveBeenCalledWith("s1", expect.stringContaining("No executor model configured"));

        const noSessionModel = createHostHarness(undefined);
        await executeConductorCommand("s1", "on", parseConductorOptions({ executor: EXECUTOR }), noSessionModel.store, noSessionModel.host);
        expect(noSessionModel.store.get("s1").enabled).toBe(false);
        expect(noSessionModel.host.sendNotice).toHaveBeenCalledWith("s1", expect.stringContaining("Could not determine planner model"));
    });

    it("skips redundant switchModel on /conductor on when already on planner, updates executor, and handles off", async () => {
        const { store, host } = createHostHarness(PLANNER);
        const options = parseConductorOptions({ executor: EXECUTOR });

        await executeConductorCommand("s1", "on", options, store, host);
        expect(host.switchModel).not.toHaveBeenCalled();
        expect(store.get("s1")).toMatchObject({ enabled: true, phase: "PLANNING", plannerModel: PLANNER, executorModel: EXECUTOR });

        const current = store.get("s1");
        if (!current.enabled) throw new Error("Expected enabled");
        await store.set("s1", { ...current, phase: "EXECUTING", phaseEpoch: 2 });

        await executeConductorCommand("s1", "opencode/flint-40b-free", options, store, host);
        expect(host.switchModel).toHaveBeenCalledWith("s1", { providerID: "opencode", id: "flint-40b-free" });

        await executeConductorCommand("s1", "", options, store, host);
        expect(host.sendNotice).toHaveBeenLastCalledWith("s1", expect.stringContaining("phase: EXECUTING"));

        await executeConductorCommand("s1", "off", options, store, host);
        expect(host.switchModel).toHaveBeenLastCalledWith("s1", PLANNER);
        expect(store.get("s1")).toEqual({ enabled: false });
    });

    it("enables from disabled state with inline model, avoids reflecting unknown input, and disables even if switchModel fails", async () => {
        const { store, host } = createHostHarness(PLANNER);
        const options = parseConductorOptions({});

        await executeConductorCommand("s1", "bad#prov/model", options, store, host);
        expect(store.get("s1").enabled).toBe(false);
        expect(host.sendNotice).toHaveBeenLastCalledWith("s1", expect.not.stringContaining("bad#prov/model"));

        await executeConductorCommand("s1", "opencode/flint-40b-free", options, store, host);
        expect(store.get("s1")).toMatchObject({
            enabled: true,
            phase: "PLANNING",
            executorModel: { providerID: "opencode", id: "flint-40b-free" },
        });

        const current = store.get("s1");
        if (!current.enabled) throw new Error("Expected enabled");
        await store.set("s1", { ...current, phase: "EXECUTING", phaseEpoch: 2 });
        vi.mocked(host.switchModel).mockRejectedValueOnce(new Error("planner offline"));

        await executeConductorCommand("s1", "off", options, store, host);
        expect(store.get("s1")).toEqual({ enabled: false });
        expect(host.sendNotice).toHaveBeenLastCalledWith("s1", expect.stringContaining("Warning: Could not restore planner model"));
        expect(host.sendNotice).toHaveBeenLastCalledWith("s1", expect.not.stringContaining("planner offline"));
    });
});

describe("custom tool definitions", () => {
    it("registers exit_plan_mode and enter_plan_mode with codemode disabled and bounded Zod schemas", async () => {
        const exitCalls: Array<unknown> = [];
        const enterCalls: Array<unknown> = [];
        const exitTool = createExitPlanModeTool(async (sessionID, contract, messageID) => {
            exitCalls.push({ sessionID, contract, messageID });
            return { content: "handed off" };
        });
        const enterTool = createEnterPlanModeTool(async (sessionID, review) => {
            enterCalls.push({ sessionID, review });
            return { content: "[plan review]" };
        });

        expect(exitTool.name).toBe("exit_plan_mode");
        expect(exitTool.input).toBe(ExitPlanModeSchema);
        expect(exitTool.options).toEqual({ codemode: false });
        expect(enterTool.name).toBe("enter_plan_mode");
        expect(enterTool.input).toBe(EnterPlanModeSchema);
        expect(enterTool.options).toEqual({ codemode: false });

        const toolContext = { sessionID: "s1", messageID: "msg-1" } as never;
        await expect(
            exitTool.execute({ plan: "1. Edit", verification: ["npm test"], rePlanIf: ["Fails"] }, toolContext),
        ).resolves.toEqual({ content: "handed off" });
        await expect(
            enterTool.execute({ reason: "Blocker", completedSteps: ["Read"] }, toolContext),
        ).resolves.toEqual({ content: "[plan review]" });
        await expect(exitTool.execute({ plan: "", verification: [], rePlanIf: [] }, toolContext)).rejects.toThrow();
        await expect(enterTool.execute({ reason: "", completedSteps: [] }, toolContext)).rejects.toThrow();
        expect(exitCalls).toHaveLength(1);
        expect(enterCalls).toHaveLength(1);
    });
});
