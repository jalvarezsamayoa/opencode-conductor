/**
 * Canonical domain types for opencode-conductor.
 */

export type ConductorPhase = "PLANNING" | "EXECUTING";

export interface ModelRef {
    readonly providerID: string;
    readonly id: string;
    readonly variant?: string;
}

export interface PlanContract {
    readonly planText: string;
    readonly verificationChecks: ReadonlyArray<string>;
    readonly replanTriggers: ReadonlyArray<string>;
}

export interface DisabledConductorState {
    readonly enabled: false;
}

export interface EnabledConductorState {
    readonly enabled: true;
    readonly paused: boolean;
    readonly phase: ConductorPhase;
    readonly phaseEpoch: number;
    readonly plannerModel: ModelRef;
    readonly executorModel: ModelRef;
    readonly activeContract?: PlanContract;
    readonly pendingInterruptionNote?: string;
    readonly consecutiveToolFailures: number;
    readonly autoHandbacksThisTurn: number;
}

export type SessionConductorState = DisabledConductorState | EnabledConductorState;

export interface ConductorOptions {
    readonly planner?: ModelRef;
    readonly executor?: ModelRef;
    readonly maxConsecutiveFailures: number;
    readonly blockedPlanTools: ReadonlyArray<string>;
    readonly promptShellInPlanMode: boolean;
    readonly configWarning?: string;
}

export interface TransitionDecision {
    readonly nextState: EnabledConductorState;
    readonly targetModel?: ModelRef;
    readonly syntheticReviewPrompt?: string;
}

export interface ToolAccessDecision {
    readonly allowed: boolean;
    readonly rejectionReason?: string;
}
