import { formatModelRef, modelsEqual, parseModelRef } from "../config/options.js";
import { formatConductorStatusMessage } from "../core/protocol-messages.js";
import type { ConductorStateStore } from "../core/state-store.js";
import type { ConductorOptions, EnabledConductorState, ModelRef } from "../core/types.js";

export type ParsedConductorCommand =
    | { readonly kind: "status" }
    | { readonly kind: "on" }
    | { readonly kind: "off" }
    | { readonly kind: "set_executor"; readonly model: ModelRef }
    | { readonly kind: "unknown" };

export interface ConductorCommandHost {
    readonly getSessionModel: (sessionID: string) => Promise<ModelRef | undefined>;
    readonly switchModel: (sessionID: string, model: ModelRef) => Promise<void>;
    readonly sendNotice: (sessionID: string, text: string) => Promise<void>;
}

const COMMAND_PREFIX_PATTERN = /^\/conductor\b/i;

/**
 * Parses `/conductor` command arguments, stripping an optional leading `/conductor` token.
 */
export function parseConductorCommandArgs(rawText: string): ParsedConductorCommand {
    const normalized = rawText.trim().replace(COMMAND_PREFIX_PATTERN, "").trim();
    const keyword = normalized.toLowerCase();
    if (keyword === "" || keyword === "status") {
        return { kind: "status" };
    }
    if (keyword === "on") {
        return { kind: "on" };
    }
    if (keyword === "off") {
        return { kind: "off" };
    }
    return parseExecutorOrUnknown(normalized);
}

function parseExecutorOrUnknown(argumentText: string): ParsedConductorCommand {
    if (!argumentText.includes("/")) {
        return { kind: "unknown" };
    }
    try {
        return { kind: "set_executor", model: parseModelRef(argumentText) };
    } catch {
        return { kind: "unknown" };
    }
}

/**
 * Executes a parsed `/conductor` command against the session state store and host adapter.
 */
export async function executeConductorCommand(
    sessionID: string,
    rawText: string,
    options: ConductorOptions,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<void> {
    const command = parseConductorCommandArgs(rawText);
    if (command.kind === "status") {
        await handleStatus(sessionID, options, store, host);
        return;
    }
    if (command.kind === "unknown") {
        await host.sendNotice(sessionID, formatUsageHelp());
        return;
    }
    await dispatchStateMutation(sessionID, command, options, store, host);
}

async function dispatchStateMutation(
    sessionID: string,
    command: Extract<ParsedConductorCommand, { kind: "on" | "off" | "set_executor" }>,
    options: ConductorOptions,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<void> {
    if (command.kind === "on") {
        await handleEnable(sessionID, options, store, host);
        return;
    }
    if (command.kind === "off") {
        await handleDisable(sessionID, store, host);
        return;
    }
    await handleSetExecutor(sessionID, command.model, options, store, host);
}

async function handleStatus(
    sessionID: string,
    options: ConductorOptions,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<void> {
    const message = formatConductorStatusMessage(store.get(sessionID), options.configWarning, options);
    await host.sendNotice(sessionID, message);
}

async function handleEnable(
    sessionID: string,
    options: ConductorOptions,
    store: ConductorStateStore,
    host: ConductorCommandHost,
    overrideExecutor?: ModelRef,
): Promise<void> {
    const notice = await store.runExclusive(sessionID, () =>
        enableInsideLock(sessionID, options, store, host, overrideExecutor),
    );
    await host.sendNotice(sessionID, notice);
}

async function enableInsideLock(
    sessionID: string,
    options: ConductorOptions,
    store: ConductorStateStore,
    host: ConductorCommandHost,
    overrideExecutor?: ModelRef,
): Promise<string> {
    const existing = store.get(sessionID);
    const executorModel = resolveExecutorModel(existing, options, overrideExecutor);
    if (!executorModel) {
        return formatMissingExecutorHint(options.configWarning);
    }
    const sessionModel = await host.getSessionModel(sessionID);
    const plannerModel = resolvePlannerModel(existing, options, sessionModel);
    if (!plannerModel) {
        return "Could not determine planner model. Select a model in OpenCode or set `planner` in plugin options.";
    }
    return persistPlanningActivation(sessionID, existing, plannerModel, executorModel, sessionModel, store, host);
}

async function persistPlanningActivation(
    sessionID: string,
    existing: ReturnType<ConductorStateStore["get"]>,
    plannerModel: ModelRef,
    executorModel: ModelRef,
    sessionModel: ModelRef | undefined,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<string> {
    if (!modelsEqual(sessionModel, plannerModel)) {
        await host.switchModel(sessionID, plannerModel);
    }
    store.clearCallEpochs(sessionID);
    store.clearExitPlanMessage(sessionID);
    const nextEpoch = existing.enabled ? existing.phaseEpoch + 1 : 1;
    const nextState: EnabledConductorState = {
        enabled: true,
        paused: false,
        phase: "PLANNING",
        phaseEpoch: nextEpoch,
        plannerModel,
        executorModel,
        consecutiveToolFailures: 0,
        autoHandbacksThisTurn: 0,
    };
    await store.set(sessionID, nextState);
    return `Conductor enabled (PLANNING: ${formatModelRef(plannerModel)}, EXECUTING: ${formatModelRef(executorModel)}).`;
}

async function handleSetExecutor(
    sessionID: string,
    executorModel: ModelRef,
    options: ConductorOptions,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<void> {
    const notice = await store.runExclusive(sessionID, async () => {
        const current = store.get(sessionID);
        if (!current.enabled) {
            return enableInsideLock(sessionID, options, store, host, executorModel);
        }
        return updateActiveExecutor(sessionID, current, executorModel, store, host);
    });
    await host.sendNotice(sessionID, notice);
}

async function updateActiveExecutor(
    sessionID: string,
    current: EnabledConductorState,
    executorModel: ModelRef,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<string> {
    if (current.phase === "EXECUTING" && !current.paused && !modelsEqual(current.executorModel, executorModel)) {
        await host.switchModel(sessionID, executorModel);
    }
    await store.set(sessionID, { ...current, executorModel });
    return `Conductor executor updated to ${formatModelRef(executorModel)}.`;
}

async function handleDisable(
    sessionID: string,
    store: ConductorStateStore,
    host: ConductorCommandHost,
): Promise<void> {
    const notice = await store.runExclusive(sessionID, async () => {
        const current = store.get(sessionID);
        const warning = await tryRestorePlannerOnDisable(sessionID, current, host);
        await store.deleteSession(sessionID);
        return warning
            ? `Conductor disabled for this session. Warning: ${warning}`
            : "Conductor disabled for this session.";
    });
    await host.sendNotice(sessionID, notice);
}

async function tryRestorePlannerOnDisable(
    sessionID: string,
    current: ReturnType<ConductorStateStore["get"]>,
    host: ConductorCommandHost,
): Promise<string | undefined> {
    if (!current.enabled || current.phase !== "EXECUTING") {
        return undefined;
    }
    try {
        await host.switchModel(sessionID, current.plannerModel);
        return undefined;
    } catch {
        return "Could not restore planner model; switch models manually if needed.";
    }
}

function resolveExecutorModel(
    existing: ReturnType<ConductorStateStore["get"]>,
    options: ConductorOptions,
    overrideExecutor?: ModelRef,
): ModelRef | undefined {
    if (overrideExecutor) {
        return overrideExecutor;
    }
    return existing.enabled ? existing.executorModel : options.executor;
}

function resolvePlannerModel(
    existing: ReturnType<ConductorStateStore["get"]>,
    options: ConductorOptions,
    sessionModel: ModelRef | undefined,
): ModelRef | undefined {
    if (options.planner) {
        return options.planner;
    }
    if (existing.enabled) {
        return existing.plannerModel;
    }
    return sessionModel;
}

function formatMissingExecutorHint(configWarning?: string): string {
    const lines = [
        "No executor model configured. Run `/conductor <provider>/<model>` or set `executor` under `opencode-conductor` options in `opencode.jsonc`.",
    ];
    if (configWarning) {
        lines.push(`Warning: ${configWarning}`);
    }
    return lines.join("\n");
}

function formatUsageHelp(): string {
    return "Usage: /conductor [on | off | status | <provider>/<model>[#<variant>]]";
}
