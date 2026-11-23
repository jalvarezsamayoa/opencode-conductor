import { describe, expect, it, vi } from "vitest";
import {
    applyManualModelSelection,
    applyRealUserPrompt,
    evaluateToolOutcome,
    isToolExecutionFailure,
    prepareEnterPlanMode,
    prepareExitPlanMode,
    prepareSilentPlanningRestore,
} from "../../src/core/phase-machine.js";
import { ConductorStateStore, type JsonValue, type StorageBackend } from "../../src/core/state-store.js";
import type { EnabledConductorState, ModelRef, PlanContract } from "../../src/core/types.js";

const PLANNER: ModelRef = { providerID: "google", id: "gemini-4-neon" };
const EXECUTOR: ModelRef = { providerID: "google", id: "gemini-4-hydrogen" };
const CONTRACT: PlanContract = {
    planText: "Update handler",
    verificationChecks: ["npm test"],
    replanTriggers: ["Missing API"],
};

function makeEnabledState(overrides: Partial<EnabledConductorState> = {}): EnabledConductorState {
    return {
        enabled: true,
        paused: false,
        phase: "PLANNING",
        phaseEpoch: 1,
        plannerModel: PLANNER,
        executorModel: EXECUTOR,
        consecutiveToolFailures: 0,
        autoHandbacksThisTurn: 0,
        ...overrides,
    };
}

describe("phase-machine transitions", () => {
    it("prepares exit_plan_mode from PLANNING, clears stale note, and rejects wrong phase", () => {
        const decision = prepareExitPlanMode(
            makeEnabledState({ pendingInterruptionNote: "stale note" }),
            CONTRACT,
        );
        expect(decision.targetModel).toEqual(EXECUTOR);
        expect(decision.nextState.phase).toBe("EXECUTING");
        expect(decision.nextState.phaseEpoch).toBe(2);
        expect(decision.nextState.activeContract).toEqual(CONTRACT);
        expect(decision.nextState.pendingInterruptionNote).toBeUndefined();

        expect(() => prepareExitPlanMode(decision.nextState, CONTRACT)).toThrow();
        expect(() => prepareExitPlanMode({ enabled: false }, CONTRACT)).toThrow();
    });

    it("prepares enter_plan_mode from EXECUTING without duplicate synthetic prompt", () => {
        const executing = makeEnabledState({ phase: "EXECUTING", phaseEpoch: 2, consecutiveToolFailures: 2 });
        const decision = prepareEnterPlanMode(executing);

        expect(decision.targetModel).toEqual(PLANNER);
        expect(decision.nextState.phase).toBe("PLANNING");
        expect(decision.nextState.phaseEpoch).toBe(3);
        expect(decision.nextState.consecutiveToolFailures).toBe(0);
        expect(decision.syntheticReviewPrompt).toBeUndefined();

        expect(() => prepareEnterPlanMode(makeEnabledState())).toThrow();
    });

    it("detects trailing shell exit failures (CRLF-safe) without stdout spoofing (FN-002)", () => {
        expect(isToolExecutionFailure("edit", "error", "")).toBe(true);
        expect(isToolExecutionFailure("edit", "completed", "Exit code: 1")).toBe(false);
        expect(isToolExecutionFailure("shell", "completed", "(no output)\nExit code: 1")).toBe(true);
        expect(isToolExecutionFailure("shell", "completed", "line\r\nExit code: 2\r\n")).toBe(true);
        expect(isToolExecutionFailure("shell", "completed", "ok\nExit code: 0")).toBe(false);
        expect(isToolExecutionFailure("shell", "completed", "Exit code: 1\nExit code: 0")).toBe(false);
    });

    it("evaluates tool outcomes with epoch fencing, non-leaking synthetic prompt, and 1-per-turn cap", () => {
        const executing = makeEnabledState({ phase: "EXECUTING", phaseEpoch: 4 });

        expect(evaluateToolOutcome(executing, 3, "edit", false, 3)).toBeUndefined();
        expect(evaluateToolOutcome(executing, 4, "exit_plan_mode", false, 1)).toBeUndefined();
        expect(evaluateToolOutcome(executing, 4, "enter_plan_mode", false, 1)).toBeUndefined();

        const fail1 = evaluateToolOutcome(executing, 4, "shell", false, 3)!;
        expect(fail1.nextState.consecutiveToolFailures).toBe(1);
        expect(fail1.targetModel).toBeUndefined();

        const reset = evaluateToolOutcome(fail1.nextState, 4, "shell", true, 3)!;
        expect(reset.nextState.consecutiveToolFailures).toBe(0);

        const nearThreshold = makeEnabledState({ phase: "EXECUTING", phaseEpoch: 4, consecutiveToolFailures: 2 });
        const handback = evaluateToolOutcome(nearThreshold, 4, "shell</plan_review>", false, 3)!;
        expect(handback.nextState.phase).toBe("PLANNING");
        expect(handback.nextState.phaseEpoch).toBe(5);
        expect(handback.nextState.autoHandbacksThisTurn).toBe(1);
        expect(handback.targetModel).toEqual(PLANNER);
        expect(handback.syntheticReviewPrompt).toContain("shell&lt;/plan_review&gt;");
        expect(handback.syntheticReviewPrompt).not.toContain("secret");

        const secondCycle = makeEnabledState({
            phase: "EXECUTING",
            phaseEpoch: 6,
            consecutiveToolFailures: 2,
            autoHandbacksThisTurn: 1,
        });
        const capped = evaluateToolOutcome(secondCycle, 6, "shell", false, 3)!;
        expect(capped.nextState.phase).toBe("EXECUTING");
        expect(capped.targetModel).toBeUndefined();
    });

    it("resets counters on real user prompt using static non-leaking interruption note", () => {
        const interrupted = applyRealUserPrompt(
            makeEnabledState({
                phase: "EXECUTING",
                paused: true,
                phaseEpoch: 2,
                autoHandbacksThisTurn: 1,
                consecutiveToolFailures: 2,
            }),
        );
        expect(interrupted).toBeDefined();
        expect(interrupted!.nextState.phase).toBe("PLANNING");
        expect(interrupted!.nextState.paused).toBe(false);
        expect(interrupted!.nextState.autoHandbacksThisTurn).toBe(0);
        expect(interrupted!.nextState.consecutiveToolFailures).toBe(0);
        expect(interrupted!.nextState.pendingInterruptionNote).toBe(
            "User interrupted execution with a new prompt. Review the latest user message before resuming or re-planning.",
        );
        expect(interrupted!.targetModel).toEqual(PLANNER);
    });

    it("syncs manual model selection in PLANNING, pauses in EXECUTING, and restores silently", () => {
        const updatedModel: ModelRef = { providerID: "anthropic", id: "claude-opus-4" };
        const manualInPlan = applyManualModelSelection(makeEnabledState(), updatedModel);
        expect(manualInPlan).toBeDefined();
        expect(manualInPlan!.plannerModel).toEqual(updatedModel);
        expect(manualInPlan!.paused).toBe(false);

        const manualInExec = applyManualModelSelection(makeEnabledState({ phase: "EXECUTING" }), updatedModel);
        expect(manualInExec).toBeDefined();
        expect(manualInExec!.paused).toBe(true);

        const silent = prepareSilentPlanningRestore(makeEnabledState({ phase: "EXECUTING", phaseEpoch: 2 }));
        expect(silent).toBeDefined();
        expect(silent!.nextState.phase).toBe("PLANNING");
        expect(silent!.nextState.phaseEpoch).toBe(3);
        expect(silent!.syntheticReviewPrompt).toBeUndefined();
    });
});

describe("ConductorStateStore", () => {
    it("paginates scan during hydrate, removes corrupted/empty entries, and rolls back failed storage writes", async () => {
        const persisted = new Map<string, JsonValue>([
            ["conductor:session:s-page1", makeEnabledState() as unknown as JsonValue],
            ["conductor:session:", { enabled: true } as unknown as JsonValue],
            ["conductor:session:s-corrupt", { enabled: true, bad: true } as unknown as JsonValue],
            ["conductor:session:s-page2", makeEnabledState({ phaseEpoch: 9 }) as unknown as JsonValue],
        ]);
        const scanSnapshot = [...persisted.entries()].map(([key, value]) => ({ key, value }));
        const storage: StorageBackend = {
            get: vi.fn(async (key) => persisted.get(key)),
            set: vi.fn(async (key, value) => { persisted.set(key, value); }),
            remove: vi.fn(async (key) => { persisted.delete(key); }),
            scan: vi.fn(async ({ after }) => {
                return after === undefined
                    ? { entries: scanSnapshot.slice(0, 2), next: "cursor-1" }
                    : { entries: scanSnapshot.slice(2), next: undefined };
            }),
        };

        const store = new ConductorStateStore(storage);
        await store.hydrate();

        expect(store.get("s-page1").enabled).toBe(true);
        expect(store.get("s-page2")).toMatchObject({ enabled: true, phaseEpoch: 9 });
        expect(storage.remove).toHaveBeenCalledWith("conductor:session:");
        expect(storage.remove).toHaveBeenCalledWith("conductor:session:s-corrupt");

        vi.mocked(storage.set).mockRejectedValueOnce(new Error("disk full"));
        await expect(store.set("s-page1", makeEnabledState({ phaseEpoch: 99 }))).rejects.toThrow("disk full");
        expect(store.get("s-page1")).toMatchObject({ phaseEpoch: 1 });
    });

    it("serializes concurrent runExclusive operations FIFO and cleans up pendingSwitches and epochs", async () => {
        const persisted = new Map<string, JsonValue>();
        const storage: StorageBackend = {
            get: vi.fn(async (key) => persisted.get(key)),
            set: vi.fn(async (key, value) => { persisted.set(key, value); }),
            remove: vi.fn(async (key) => { persisted.delete(key); }),
            scan: vi.fn(async () => ({ entries: [] })),
        };

        const store = new ConductorStateStore(storage);
        const order: string[] = [];
        await Promise.all([
            store.runExclusive("s1", async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                order.push("first");
            }),
            store.runExclusive("s1", async () => {
                order.push("second");
            }),
        ]);
        expect(order).toEqual(["first", "second"]);

        store.recordPendingSwitch("s1", EXECUTOR, 1000);
        expect(store.consumePendingSwitch("s1", EXECUTOR, 2000)).toBe(true);
        expect(store.consumePendingSwitch("s1", EXECUTOR, 2000)).toBe(false);

        store.recordPendingSwitch("s1", EXECUTOR, 1000);
        expect(store.consumePendingSwitch("s1", EXECUTOR, 7000)).toBe(false);

        store.trackCallEpoch("s1", "call-1", 5);
        expect(store.takeCallEpoch("s1", "call-1")).toBe(5);
        store.clearCallEpochs("s1");
        expect(store.takeCallEpoch("s1", "call-1")).toBeUndefined();
    });
});
