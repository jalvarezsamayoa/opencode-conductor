import type { SessionConductorState, ToolAccessDecision } from "./types.js";

export type PermissionEffect = "allow" | "deny" | "ask";

export const EXIT_PLAN_TOOL = "exit_plan_mode";
export const ENTER_PLAN_TOOL = "enter_plan_mode";

const CONDUCTOR_TOOLS: ReadonlySet<string> = new Set([EXIT_PLAN_TOOL, ENTER_PLAN_TOOL]);

/**
 * Evaluates whether a tool invocation is allowed under the current Conductor state.
 */
export function evaluateToolAccess(
    conductorState: SessionConductorState,
    toolName: string,
    isCodeMode: boolean,
    blockedPlanTools: ReadonlySet<string>,
): ToolAccessDecision {
    if (!conductorState.enabled || conductorState.paused) {
        return evaluateInactiveTool(toolName);
    }
    if (conductorState.phase === "PLANNING") {
        return evaluatePlanningTool(toolName, isCodeMode, blockedPlanTools);
    }
    return evaluateExecutingTool(toolName);
}

function evaluateInactiveTool(toolName: string): ToolAccessDecision {
    if (CONDUCTOR_TOOLS.has(toolName)) {
        return {
            allowed: false,
            rejectionReason: "Conductor is not active on this session. Run /conductor on to enable.",
        };
    }
    return { allowed: true };
}

function evaluatePlanningTool(
    toolName: string,
    isCodeMode: boolean,
    blockedPlanTools: ReadonlySet<string>,
): ToolAccessDecision {
    if (isCodeMode || blockedPlanTools.has(toolName) || toolName === ENTER_PLAN_TOOL) {
        return {
            allowed: false,
            rejectionReason: "Plan mode is active: mutating and codemode tools are disabled until exit_plan_mode runs.",
        };
    }
    return { allowed: true };
}

function evaluateExecutingTool(toolName: string): ToolAccessDecision {
    if (toolName === EXIT_PLAN_TOOL) {
        return {
            allowed: false,
            rejectionReason: "Execution mode is active: call enter_plan_mode to return to planning.",
        };
    }
    return { allowed: true };
}

/**
 * Filters a context tool map so disallowed tools are omitted from the model prompt.
 */
export function filterToolsForContext<ToolDescriptor>(
    conductorState: SessionConductorState,
    tools: Readonly<Record<string, ToolDescriptor>>,
    blockedPlanTools: ReadonlySet<string>,
): Record<string, ToolDescriptor> {
    const filtered: Record<string, ToolDescriptor> = {};
    for (const [toolName, descriptor] of Object.entries(tools)) {
        if (evaluateToolAccess(conductorState, toolName, false, blockedPlanTools).allowed) {
            filtered[toolName] = descriptor;
        }
    }
    return filtered;
}

/**
 * Downgrades `"allow"` to `"ask"` for `"shell"` during active `PLANNING`, preserving `"deny"`.
 */
export function evaluateShellPermission(
    conductorState: SessionConductorState,
    action: string,
    currentEffect: PermissionEffect,
    promptShellInPlanMode: boolean,
): PermissionEffect {
    if (!isShellAskEligible(conductorState, action, currentEffect, promptShellInPlanMode)) {
        return currentEffect;
    }
    return "ask";
}

function isShellAskEligible(
    conductorState: SessionConductorState,
    action: string,
    currentEffect: PermissionEffect,
    promptShellInPlanMode: boolean,
): boolean {
    if (!promptShellInPlanMode || action !== "shell" || currentEffect !== "allow") {
        return false;
    }
    return isPlanningActive(conductorState);
}

function isPlanningActive(conductorState: SessionConductorState): boolean {
    return conductorState.enabled && !conductorState.paused && conductorState.phase === "PLANNING";
}
