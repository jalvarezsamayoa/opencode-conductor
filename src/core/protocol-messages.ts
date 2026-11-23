import { formatModelRef } from "../config/options.js";
import type { ConductorOptions, PlanContract, SessionConductorState } from "./types.js";

const PROTOCOL_TAG_PATTERN = /<\s*(?:\/\s*)?(?:conductor_protocol|active_plan|plan_review)\b(?:[^>]*>)?/gi;

export interface PlanReviewInput {
    readonly reason: string;
    readonly completedSteps: ReadonlyArray<string>;
    readonly blocker?: string | undefined;
    readonly verificationOutput?: string | undefined;
}

/**
 * Neutralizes structural Conductor XML-like tags inside untrusted text, including unclosed or whitespace-padded tags.
 */
export function neutralizeProtocolTags(rawText: string): string {
    return rawText.replace(PROTOCOL_TAG_PATTERN, (matched) =>
        matched.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
}

/**
 * Formats the system prompt instructions appended while Conductor is in PLANNING.
 */
export function formatPlanningSystemMessage(pendingInterruptionNote?: string): string {
    const lines = [
        `<conductor_protocol phase="PLANNING">`,
        "You are the Planning model in read-only mode.",
        "Inspect the repository, resolve ambiguities, and design an ordered plan with verification commands and Re-plan if triggers.",
        "If the user asked a question or requested a review with no code changes, answer directly and do not call exit_plan_mode.",
        "When code edits are needed, call exit_plan_mode with your plan, verification checks, and rePlanIf triggers to hand execution to the fast model.",
    ];
    if (pendingInterruptionNote) {
        lines.push("<plan_review>");
        lines.push(neutralizeProtocolTags(pendingInterruptionNote));
        lines.push("</plan_review>");
    }
    lines.push("</conductor_protocol>");
    return lines.join("\n");
}

/**
 * Formats the system prompt instructions appended while Conductor is in EXECUTING.
 */
export function formatExecutingSystemMessage(contract?: PlanContract): string {
    const lines = [
        `<conductor_protocol phase="EXECUTING">`,
        "You are the Execution model carrying out the approved plan below.",
        "Follow the steps in order, run verification commands, and avoid improvising outside the plan.",
        "Call enter_plan_mode immediately if any rePlanIf condition occurs, a required assumption fails, or you need an architectural decision.",
    ];
    if (contract) {
        lines.push("<active_plan>");
        lines.push(formatContractBody(contract));
        lines.push("</active_plan>");
    }
    lines.push("</conductor_protocol>");
    return lines.join("\n");
}

function formatContractBody(contract: PlanContract): string {
    const sections = [neutralizeProtocolTags(contract.planText)];
    appendLabeledList(sections, "Verification:", contract.verificationChecks);
    appendLabeledList(sections, "Re-plan if:", contract.replanTriggers);
    return sections.join("\n\n");
}

function appendLabeledList(sections: string[], heading: string, items: ReadonlyArray<string>): void {
    if (items.length === 0) {
        return;
    }
    const bullets = items.map((item) => `- ${neutralizeProtocolTags(item)}`).join("\n");
    sections.push(`${heading}\n${bullets}`);
}

/**
 * Formats the tool result returned to the Executor after `exit_plan_mode`.
 */
export function formatExecutionHandoffMessage(contract: PlanContract): string {
    return [
        "Execution phase active. Carry out the approved plan below:",
        "",
        formatContractBody(contract),
    ].join("\n");
}

/**
 * Formats the `[plan review]` payload returned to the Planner by `enter_plan_mode`.
 */
export function formatPlanReviewMessage(input: PlanReviewInput): string {
    const lines = [`[plan review] Execution handed back to Planning: ${neutralizeProtocolTags(input.reason)}`];
    appendLabeledList(lines, "Completed steps:", input.completedSteps);
    if (input.blocker) {
        lines.push(`Blocker: ${neutralizeProtocolTags(input.blocker)}`);
    }
    if (input.verificationOutput) {
        lines.push(`Verification output:\n${neutralizeProtocolTags(input.verificationOutput)}`);
    }
    return lines.join("\n\n");
}

/**
 * Formats the `/conductor status` summary message for the user session.
 */
export function formatConductorStatusMessage(
    state: SessionConductorState,
    configWarning?: string,
    options?: Pick<ConductorOptions, "planner" | "executor">,
): string {
    const lines = state.enabled
        ? formatEnabledStatusLines(state)
        : formatDisabledStatusLines(options);
    if (configWarning) {
        lines.push(`configWarning: ${configWarning}`);
    }
    return lines.join("\n");
}

function formatEnabledStatusLines(state: Extract<SessionConductorState, { enabled: true }>): string[] {
    return [
        "Conductor status:",
        `- enabled: true`,
        `- phase: ${state.phase}`,
        `- paused: ${state.paused}`,
        `- planner: ${formatModelRef(state.plannerModel)}`,
        `- executor: ${formatModelRef(state.executorModel)}`,
    ];
}

function formatDisabledStatusLines(options?: Pick<ConductorOptions, "planner" | "executor">): string[] {
    const plannerText = options?.planner ? formatModelRef(options.planner) : "(session default)";
    const executorText = options?.executor ? formatModelRef(options.executor) : "(not configured)";
    return [
        "Conductor status:",
        "- enabled: false",
        `- configured planner: ${plannerText}`,
        `- configured executor: ${executorText}`,
    ];
}
