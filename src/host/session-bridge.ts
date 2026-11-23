import { resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ToolHooks } from "@opencode/plugin/promise/tool";
import type { ConductorCommandHost } from "../commands/conductor-command.js";
import { isCleanModelToken } from "../config/options.js";
import {
    applyManualModelSelection,
    applyRealUserPrompt,
    evaluateToolOutcome,
    isToolExecutionFailure,
    prepareEnterPlanMode,
    prepareExitPlanMode,
    prepareSilentPlanningRestore,
} from "../core/phase-machine.js";
import {
    formatExecutingSystemMessage,
    formatExecutionHandoffMessage,
    formatPlanReviewMessage,
    formatPlanningSystemMessage,
    type PlanReviewInput,
} from "../core/protocol-messages.js";
import type { ConductorStateStore } from "../core/state-store.js";
import {
    evaluateShellPermission,
    evaluateToolAccess,
    filterToolsForContext,
} from "../core/tool-guard.js";
import type { ConductorOptions, EnabledConductorState, ModelRef, PlanContract } from "../core/types.js";

type Context = Plugin.Context;

interface LocationRef {
    readonly directory?: string;
    readonly workspaceID?: string;
}

/**
 * Bridges pure Conductor domain logic to OpenCode 2 session, tool, permission, and event APIs.
 */
export class ConductorSessionBridge implements ConductorCommandHost {
    private readonly blockedPlanTools: ReadonlySet<string>;
    private readonly ownDirectory: string;

    constructor(
        private readonly context: Context,
        private readonly options: ConductorOptions,
        private readonly store: ConductorStateStore,
    ) {
        this.blockedPlanTools = new Set(options.blockedPlanTools);
        this.ownDirectory = normalizeDirectory(context.location.directory);
    }

    async getSessionModel(sessionID: string): Promise<ModelRef | undefined> {
        const info = await this.context.session.get({ sessionID });
        return toModelRef(info.model);
    }

    async switchModel(sessionID: string, model: ModelRef): Promise<void> {
        this.store.recordPendingSwitch(sessionID, model);
        try {
            await this.context.session.switchModel({ sessionID, model });
        } catch (error) {
            this.store.removePendingSwitch(sessionID, model);
            throw error;
        }
    }

    async sendNotice(
        sessionID: string,
        text: string,
        resume = false,
        delivery?: "steer" | "queue",
    ): Promise<void> {
        await this.context.session.synthetic({
            sessionID,
            text,
            resume,
            metadata: { conductorSynthetic: true },
            ...(delivery ? { delivery } : {}),
        });
    }

    async handleExitPlanMode(
        sessionID: string,
        contract: PlanContract,
        messageID: string,
    ): Promise<{ readonly content: string }> {
        return this.store.runExclusive(sessionID, async () => {
            const decision = prepareExitPlanMode(this.store.get(sessionID), contract);
            if (decision.targetModel) {
                await this.switchModel(sessionID, decision.targetModel);
            }
            await this.store.set(sessionID, decision.nextState);
            this.store.markExitPlanMessage(sessionID, messageID);
            return { content: formatExecutionHandoffMessage(contract) };
        });
    }

    async handleEnterPlanMode(sessionID: string, reviewInput: PlanReviewInput): Promise<{ readonly content: string }> {
        return this.store.runExclusive(sessionID, async () => {
            const reviewText = formatPlanReviewMessage(reviewInput);
            const decision = prepareEnterPlanMode(this.store.get(sessionID));
            if (decision.targetModel) {
                await this.switchModel(sessionID, decision.targetModel);
            }
            await this.store.set(sessionID, decision.nextState);
            this.clearExecutionTracking(sessionID);
            return { content: reviewText };
        });
    }

    async handlePrompt(input: {
        readonly sessionID: string;
        readonly metadata?: Record<string, unknown> | undefined;
    }): Promise<void> {
        if (input.metadata?.conductorSynthetic === true) {
            return;
        }
        await this.store.runExclusive(input.sessionID, async () => {
            const decision = applyRealUserPrompt(this.store.get(input.sessionID));
            if (!decision) {
                return;
            }
            if (decision.targetModel) {
                await this.switchModel(input.sessionID, decision.targetModel);
            }
            await this.store.set(input.sessionID, decision.nextState);
            this.clearExecutionTracking(input.sessionID);
        });
    }

    async handleContext(input: SessionContext): Promise<void> {
        this.store.clearExitPlanMessage(input.sessionID);
        const state = this.store.get(input.sessionID);
        input.tools = filterToolsForContext(state, input.tools, this.blockedPlanTools);
        if (!state.enabled || state.paused) {
            return;
        }
        await this.appendProtocolSystemPart(input.sessionID, state, input.system);
    }

    private async appendProtocolSystemPart(
        sessionID: string,
        initialState: EnabledConductorState,
        systemParts: SessionContext["system"],
    ): Promise<void> {
        if (initialState.phase === "EXECUTING") {
            systemParts.push({ type: "text", text: formatExecutingSystemMessage(initialState.activeContract) });
            return;
        }
        systemParts.push({ type: "text", text: formatPlanningSystemMessage(initialState.pendingInterruptionNote) });
        if (initialState.pendingInterruptionNote !== undefined) {
            await this.clearPendingNoteSafely(sessionID);
        }
    }

    private async clearPendingNoteSafely(sessionID: string): Promise<void> {
        await this.store.runExclusive(sessionID, async () => {
            const current = this.store.get(sessionID);
            if (!current.enabled || current.pendingInterruptionNote === undefined) {
                return;
            }
            await this.store.set(sessionID, omitInterruptionNote(current));
        });
    }

    handleBeforeTool(input: {
        readonly sessionID: string;
        readonly tool: string;
        readonly codemode: boolean;
        readonly messageID: string;
        readonly id: string;
    }): void {
        const state = this.store.get(input.sessionID);
        const effectiveState = this.resolveBeforeToolState(input.sessionID, input.messageID, state);
        const decision = evaluateToolAccess(effectiveState, input.tool, input.codemode, this.blockedPlanTools);
        if (!decision.allowed) {
            throw new Error(decision.rejectionReason);
        }
        if (effectiveState.enabled && !effectiveState.paused && effectiveState.phase === "EXECUTING") {
            this.store.trackCallEpoch(input.sessionID, input.id, effectiveState.phaseEpoch);
        }
    }

    private resolveBeforeToolState(
        sessionID: string,
        messageID: string,
        state: ReturnType<ConductorStateStore["get"]>,
    ): ReturnType<ConductorStateStore["get"]> {
        if (state.enabled && this.store.isExitPlanMessage(sessionID, messageID)) {
            return { ...state, phase: "PLANNING" };
        }
        return state;
    }

    async handleAfterTool(input: ToolHooks["execute.after"]): Promise<void> {
        const expectedEpoch = this.store.takeCallEpoch(input.sessionID, input.id);
        if (expectedEpoch === undefined) {
            return;
        }
        const textOutput = readToolOutcomeText(input);
        const failed = isToolExecutionFailure(input.tool, input.status, textOutput);
        await this.applyToolOutcomeTransition(input.sessionID, expectedEpoch, input.tool, !failed);
    }

    private async applyToolOutcomeTransition(
        sessionID: string,
        expectedEpoch: number,
        toolName: string,
        succeeded: boolean,
    ): Promise<void> {
        await this.store.runExclusive(sessionID, async () => {
            const decision = evaluateToolOutcome(
                this.store.get(sessionID),
                expectedEpoch,
                toolName,
                succeeded,
                this.options.maxConsecutiveFailures,
            );
            if (!decision) {
                return;
            }
            await this.commitToolDecision(sessionID, decision);
        });
    }

    private async commitToolDecision(
        sessionID: string,
        decision: NonNullable<ReturnType<typeof evaluateToolOutcome>>,
    ): Promise<void> {
        if (decision.targetModel) {
            await this.switchModel(sessionID, decision.targetModel);
        }
        await this.store.set(sessionID, decision.nextState);
        if (decision.syntheticReviewPrompt) {
            this.clearExecutionTracking(sessionID);
            await this.sendNotice(sessionID, decision.syntheticReviewPrompt, true, "steer");
        }
    }

    handlePermissionEvaluate(input: {
        readonly sessionID: string;
        readonly action: string;
        readonly source?: { readonly messageID?: string };
        effect: "allow" | "deny" | "ask";
    }): void {
        const state = this.store.get(input.sessionID);
        const messageID = input.source?.messageID;
        const effectiveState = messageID ? this.resolveBeforeToolState(input.sessionID, messageID, state) : state;
        input.effect = evaluateShellPermission(
            effectiveState,
            input.action,
            input.effect,
            this.options.promptShellInPlanMode,
        );
    }

    async handleExperimentalIdle(input: {
        readonly sessionID: string;
        readonly background: ReadonlyArray<{ readonly sessionID: string }>;
    }): Promise<void> {
        const hasSessionOwnedWork = input.background.some((item) => item.sessionID === input.sessionID);
        if (hasSessionOwnedWork) {
            return;
        }
        await this.restorePlanningSilently(input.sessionID);
    }

    async handleEvent(rawEvent: unknown): Promise<void> {
        const parsed = parseEventEnvelope(rawEvent);
        if (!parsed || !this.isOwnEventLocation(parsed.location, parsed.data.location)) {
            return;
        }
        const sessionID = readEventSessionID(parsed.data);
        if (!sessionID) {
            return;
        }
        await this.dispatchSessionEvent(parsed.type, sessionID, parsed.data);
    }

    private isOwnEventLocation(rawEventLocation: unknown, rawDataLocation: unknown): boolean {
        const location = readLocationRef(rawEventLocation) ?? readLocationRef(rawDataLocation);
        if (!location) {
            return true;
        }
        if (location.directory && normalizeDirectory(location.directory) !== this.ownDirectory) {
            return false;
        }
        return matchesWorkspace(this.context.location.workspaceID, location.workspaceID);
    }

    private async dispatchSessionEvent(
        eventType: string,
        sessionID: string,
        data: Record<string, unknown>,
    ): Promise<void> {
        if (eventType === "session.deleted") {
            await this.store.runExclusive(sessionID, () => this.store.deleteIfTracked(sessionID));
            return;
        }
        if (isForeignDescendantEvent(eventType, sessionID, data)) {
            await this.store.runExclusive(sessionID, () => this.store.deleteIfTracked(sessionID));
            return;
        }
        await this.dispatchLifecycleEvent(eventType, sessionID, data);
    }

    private async dispatchLifecycleEvent(
        eventType: string,
        sessionID: string,
        data: Record<string, unknown>,
    ): Promise<void> {
        if (eventType === "session.execution.failed" || eventType === "session.execution.interrupted") {
            await this.restorePlanningSilently(sessionID);
            return;
        }
        if (eventType === "session.model.selected") {
            await this.handleModelSelected(sessionID, data.model);
        }
    }

    private async handleModelSelected(sessionID: string, rawModel: unknown): Promise<void> {
        const selected = toModelRef(rawModel);
        if (!selected || this.store.consumePendingSwitch(sessionID, selected)) {
            return;
        }
        await this.store.runExclusive(sessionID, async () => {
            const updated = applyManualModelSelection(this.store.get(sessionID), selected);
            if (updated) {
                await this.store.set(sessionID, updated);
            }
        });
    }

    private async restorePlanningSilently(sessionID: string): Promise<void> {
        await this.store.runExclusive(sessionID, async () => {
            const decision = prepareSilentPlanningRestore(this.store.get(sessionID));
            if (!decision) {
                return;
            }
            if (decision.targetModel) {
                await this.switchModel(sessionID, decision.targetModel);
            }
            await this.store.set(sessionID, decision.nextState);
            this.clearExecutionTracking(sessionID);
        });
    }

    private clearExecutionTracking(sessionID: string): void {
        this.store.clearCallEpochs(sessionID);
        this.store.clearExitPlanMessage(sessionID);
    }
}

function omitInterruptionNote(state: EnabledConductorState): EnabledConductorState {
    return {
        enabled: true,
        paused: state.paused,
        phase: state.phase,
        phaseEpoch: state.phaseEpoch,
        plannerModel: state.plannerModel,
        executorModel: state.executorModel,
        ...(state.activeContract ? { activeContract: state.activeContract } : {}),
        consecutiveToolFailures: state.consecutiveToolFailures,
        autoHandbacksThisTurn: state.autoHandbacksThisTurn,
    };
}

function isForeignDescendantEvent(
    eventType: string,
    sessionID: string,
    data: Record<string, unknown>,
): boolean {
    if (eventType !== "session.created" && eventType !== "session.forked") {
        return false;
    }
    return typeof data.parentID === "string" && data.parentID !== sessionID;
}

function matchesWorkspace(ownWorkspaceID: string | undefined, eventWorkspaceID: string | undefined): boolean {
    if (!ownWorkspaceID || !eventWorkspaceID) {
        return true;
    }
    return ownWorkspaceID === eventWorkspaceID;
}

function normalizeDirectory(directory: string): string {
    const resolved = resolve(directory);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildLocationRef(
    directory: string | undefined,
    workspaceID: string | undefined,
): LocationRef | undefined {
    const ref: { directory?: string; workspaceID?: string } = {};
    if (directory) {
        ref.directory = directory;
    }
    if (workspaceID) {
        ref.workspaceID = workspaceID;
    }
    return Object.keys(ref).length > 0 ? ref : undefined;
}

function readLocationRef(value: unknown): LocationRef | undefined {
    if (!isPlainRecord(value)) {
        return undefined;
    }
    return buildLocationRef(readNonEmptyString(value.directory), readNonEmptyString(value.workspaceID));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventEnvelope(
    rawEvent: unknown,
): { readonly type: string; readonly location: unknown; readonly data: Record<string, unknown> } | undefined {
    if (!isPlainRecord(rawEvent) || typeof rawEvent.type !== "string") {
        return undefined;
    }
    return {
        type: rawEvent.type,
        location: rawEvent.location,
        data: isPlainRecord(rawEvent.data) ? rawEvent.data : {},
    };
}

function readEventSessionID(data: Record<string, unknown>): string | undefined {
    if (typeof data.sessionID === "string") {
        return data.sessionID;
    }
    return isPlainRecord(data.session) && typeof data.session.id === "string"
        ? data.session.id
        : undefined;
}

function readCleanModelToken(value: unknown): string | undefined {
    return typeof value === "string" && isCleanModelToken(value) ? value : undefined;
}

function attachValidatedVariant(base: ModelRef, rawVariant: unknown): ModelRef | undefined {
    if (rawVariant === undefined || rawVariant === "") {
        return base;
    }
    const variant = readCleanModelToken(rawVariant);
    return variant ? { ...base, variant } : undefined;
}

function buildCleanModelRef(value: Record<string, unknown>): ModelRef | undefined {
    const providerID = readCleanModelToken(value.providerID);
    const id = readCleanModelToken(value.id);
    if (!providerID || !id) {
        return undefined;
    }
    return attachValidatedVariant({ providerID, id }, value.variant);
}

function toModelRef(value: unknown): ModelRef | undefined {
    return isPlainRecord(value) ? buildCleanModelRef(value) : undefined;
}

function readToolOutcomeText(input: ToolHooks["execute.after"]): string {
    if (input.status === "error") {
        return input.error.message;
    }
    return extractContentText(input.result.content);
}

function extractContentText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((part): part is { readonly text: string } => isPlainRecord(part) && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}
