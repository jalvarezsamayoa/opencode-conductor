import { neutralizeProtocolTags } from "./protocol-messages.js";
import { ENTER_PLAN_TOOL, EXIT_PLAN_TOOL } from "./tool-guard.js";
import type {
    EnabledConductorState,
    ModelRef,
    PlanContract,
    SessionConductorState,
    TransitionDecision,
} from "./types.js";

const SHELL_EXIT_FAILURE_PATTERN = /(?:^|\r?\n)Exit code:\s*([1-9]\d*)\r?\s*$/;
const MAX_AUTO_HANDBACKS_PER_TURN = 1;
const CONDUCTOR_TOOLS: ReadonlySet<string> = new Set([EXIT_PLAN_TOOL, ENTER_PLAN_TOOL]);
const USER_INTERRUPTION_NOTE =
    "User interrupted execution with a new prompt. Review the latest user message before resuming or re-planning.";

/**
 * Validates and prepares the transition from `PLANNING` to `EXECUTING`.
 */
export function prepareExitPlanMode(
    currentState: SessionConductorState,
    contract: PlanContract,
): TransitionDecision {
    if (!currentState.enabled || currentState.paused || currentState.phase !== "PLANNING") {
        throw new Error("exit_plan_mode requires an active Conductor session in PLANNING phase.");
    }
    return {
        nextState: {
            enabled: true,
            paused: false,
            phase: "EXECUTING",
            phaseEpoch: currentState.phaseEpoch + 1,
            plannerModel: currentState.plannerModel,
            executorModel: currentState.executorModel,
            activeContract: contract,
            consecutiveToolFailures: 0,
            autoHandbacksThisTurn: currentState.autoHandbacksThisTurn,
        },
        targetModel: currentState.executorModel,
    };
}

/**
 * Validates and prepares the explicit hand-back from `EXECUTING` to `PLANNING`.
 */
export function prepareEnterPlanMode(
    currentState: SessionConductorState,
): TransitionDecision {
    if (!currentState.enabled || currentState.paused || currentState.phase !== "EXECUTING") {
        throw new Error("enter_plan_mode requires an active Conductor session in EXECUTING phase.");
    }
    return {
        nextState: {
            ...currentState,
            phase: "PLANNING",
            phaseEpoch: currentState.phaseEpoch + 1,
            consecutiveToolFailures: 0,
        },
        targetModel: currentState.plannerModel,
    };
}

/**
 * Detects tool execution failure, including trailing non-zero shell exit codes reported as completed text (FN-002).
 */
export function isToolExecutionFailure(
    toolName: string,
    status: "completed" | "error",
    textOutput: string,
): boolean {
    if (status === "error") {
        return true;
    }
    return toolName === "shell" && SHELL_EXIT_FAILURE_PATTERN.test(textOutput);
}

/**
 * Evaluates a completed tool call during `EXECUTING` and hands back to `PLANNING` on failure threshold.
 */
export function evaluateToolOutcome(
    currentState: SessionConductorState,
    expectedEpoch: number,
    toolName: string,
    toolSucceeded: boolean,
    maxConsecutiveFailures: number,
): TransitionDecision | undefined {
    if (!isOutcomeEligible(currentState, expectedEpoch, toolName)) {
        return undefined;
    }
    if (toolSucceeded) {
        return { nextState: { ...currentState, consecutiveToolFailures: 0 } };
    }
    return recordToolFailure(currentState, toolName, maxConsecutiveFailures);
}

function isOutcomeEligible(
    currentState: SessionConductorState,
    expectedEpoch: number,
    toolName: string,
): currentState is EnabledConductorState {
    if (!currentState.enabled || currentState.paused || currentState.phase !== "EXECUTING") {
        return false;
    }
    if (currentState.phaseEpoch !== expectedEpoch) {
        return false;
    }
    return !CONDUCTOR_TOOLS.has(toolName);
}

function recordToolFailure(
    currentState: EnabledConductorState,
    toolName: string,
    maxConsecutiveFailures: number,
): TransitionDecision {
    const nextFailures = currentState.consecutiveToolFailures + 1;
    const canHandBack = currentState.autoHandbacksThisTurn < MAX_AUTO_HANDBACKS_PER_TURN;
    if (nextFailures < maxConsecutiveFailures || !canHandBack) {
        return { nextState: { ...currentState, consecutiveToolFailures: nextFailures } };
    }
    const safeToolName = neutralizeProtocolTags(toolName);
    return {
        nextState: {
            ...currentState,
            phase: "PLANNING",
            phaseEpoch: currentState.phaseEpoch + 1,
            consecutiveToolFailures: 0,
            autoHandbacksThisTurn: currentState.autoHandbacksThisTurn + 1,
        },
        targetModel: currentState.plannerModel,
        syntheticReviewPrompt: `[plan review] Tool execution failed ${nextFailures} consecutive times (last tool: ${safeToolName}). Inspect the recent tool errors in conversation history and revise the plan.`,
    };
}

/**
 * Resets turn counters and unpauses on a real user prompt, restoring `PLANNING` if interrupting `EXECUTING`.
 */
export function applyRealUserPrompt(
    currentState: SessionConductorState,
): TransitionDecision | undefined {
    if (!currentState.enabled) {
        return undefined;
    }
    const resetBase: EnabledConductorState = {
        ...currentState,
        paused: false,
        consecutiveToolFailures: 0,
        autoHandbacksThisTurn: 0,
    };
    if (currentState.phase === "PLANNING") {
        return { nextState: resetBase };
    }
    return {
        nextState: {
            ...resetBase,
            phase: "PLANNING",
            phaseEpoch: currentState.phaseEpoch + 1,
            pendingInterruptionNote: USER_INTERRUPTION_NOTE,
        },
        targetModel: currentState.plannerModel,
    };
}

/**
 * Handles a manual user TUI model change, syncing `plannerModel` in `PLANNING` or pausing in `EXECUTING`.
 */
export function applyManualModelSelection(
    currentState: SessionConductorState,
    selectedModel: ModelRef,
): EnabledConductorState | undefined {
    if (!currentState.enabled) {
        return undefined;
    }
    if (currentState.phase === "PLANNING") {
        return { ...currentState, plannerModel: selectedModel, paused: false };
    }
    return { ...currentState, paused: true };
}

/**
 * Silently restores `PLANNING` when `EXECUTING` finishes or stops without needing another Planner turn.
 */
export function prepareSilentPlanningRestore(
    currentState: SessionConductorState,
): TransitionDecision | undefined {
    if (!currentState.enabled || currentState.paused || currentState.phase !== "EXECUTING") {
        return undefined;
    }
    return {
        nextState: {
            ...currentState,
            phase: "PLANNING",
            phaseEpoch: currentState.phaseEpoch + 1,
            consecutiveToolFailures: 0,
        },
        targetModel: currentState.plannerModel,
    };
}
