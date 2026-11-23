import type { Plugin } from "@opencode/plugin";
import { executeConductorCommand } from "../commands/conductor-command.js";
import { parseConductorOptions } from "../config/options.js";
import { ConductorStateStore, type StorageBackend } from "../core/state-store.js";
import { createEnterPlanModeTool } from "../tools/enter-plan-mode.js";
import { createExitPlanModeTool } from "../tools/exit-plan-mode.js";
import { ConductorSessionBridge } from "./session-bridge.js";

type Context = Plugin.Context;
type Registration = { readonly dispose: () => Promise<void> };

const SUBSCRIBED_EVENTS = [
    "session.deleted",
    "session.created",
    "session.forked",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.model.selected",
] as const;

const INITIAL_RECONNECT_DELAY_MS = 25;
const MAX_RECONNECT_DELAY_MS = 2_000;

/**
 * Initializes OpenCode Conductor hooks, tools, `/conductor` command, storage hydration, and event loop.
 */
export async function setupConductorPlugin(context: Context): Promise<Plugin.Cleanup> {
    const options = parseConductorOptions(context.options);
    const store = new ConductorStateStore(createStorageAdapter(context));
    await store.hydrate();

    const bridge = new ConductorSessionBridge(context, options, store);
    const registrations: Registration[] = [];
    const abortController = new AbortController();
    let eventLoopDone = Promise.resolve();

    try {
        await registerHooksAndTransforms(context, options, store, bridge, registrations);
        eventLoopDone = consumeEvents(context, bridge, abortController.signal);
    } catch (error) {
        abortController.abort();
        await disposeAll(registrations, eventLoopDone, store);
        throw error;
    }

    return async () => {
        abortController.abort();
        await disposeAll(registrations, eventLoopDone, store);
    };
}

function createStorageAdapter(context: Context): StorageBackend {
    return {
        get: (key) => context.storage.get(key),
        set: (key, value) => context.storage.set(key, value),
        remove: (key) => context.storage.remove(key),
        scan: ({ prefix, after }) =>
            context.storage.scan(after === undefined ? { prefix } : { prefix, after }),
    };
}

async function registerHooksAndTransforms(
    context: Context,
    options: ReturnType<typeof parseConductorOptions>,
    store: ConductorStateStore,
    bridge: ConductorSessionBridge,
    registrations: Registration[],
): Promise<void> {
    const exitTool = createExitPlanModeTool((sessionID, contract, messageID) =>
        bridge.handleExitPlanMode(sessionID, contract, messageID),
    );
    const enterTool = createEnterPlanModeTool((sessionID, review) =>
        bridge.handleEnterPlanMode(sessionID, review),
    );

    const pending: Array<Promise<Registration>> = [
        context.tool.transform((editor) => {
            editor.add(exitTool);
            editor.add(enterTool);
        }),
        context.command.transform((editor) => {
            editor.add({
                name: "conductor",
                description: "Manage two-phase Planner/Executor orchestration (/conductor [on|off|status|provider/model]).",
                execute: (invocation) =>
                    executeConductorCommand(invocation.sessionID, readInvocationText(invocation.prompt), options, store, bridge),
            });
        }),
        context.session.hook("prompt", (input) => bridge.handlePrompt(input)),
        context.session.hook("context", (input) => bridge.handleContext(input)),
        context.session.hook("experimental.idle", (input) => bridge.handleExperimentalIdle(input)),
        context.tool.hook("execute.before", (input) => bridge.handleBeforeTool(input)),
        context.tool.hook("execute.after", (input) => bridge.handleAfterTool(input)),
        context.permission.hook("evaluate", (input) => bridge.handlePermissionEvaluate(input)),
    ];

    const settled = await Promise.allSettled(pending);
    collectRegistrationsOrThrow(settled, registrations);
}

function collectRegistrationsOrThrow(
    settled: ReadonlyArray<PromiseSettledResult<Registration>>,
    registrations: Registration[],
): void {
    for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
            registrations.push(outcome.value);
        }
    }
    const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (rejected) {
        throw rejected.reason;
    }
}

async function consumeEvents(
    context: Context,
    bridge: ConductorSessionBridge,
    signal: AbortSignal,
): Promise<void> {
    let delayMs = INITIAL_RECONNECT_DELAY_MS;
    while (!signal.aborted) {
        const succeeded = await streamEventsOnce(context, bridge, signal);
        if (signal.aborted) {
            return;
        }
        delayMs = succeeded ? INITIAL_RECONNECT_DELAY_MS : Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS);
        await waitUnlessAborted(delayMs, signal);
    }
}

async function streamEventsOnce(
    context: Context,
    bridge: ConductorSessionBridge,
    signal: AbortSignal,
): Promise<boolean> {
    try {
        for await (const event of context.event.subscribe({ signal, types: SUBSCRIBED_EVENTS })) {
            if (signal.aborted) {
                return true;
            }
            await safeDispatchEvent(bridge, event);
        }
        return true;
    } catch {
        return false;
    }
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolveWait) => {
        const timer = setTimeout(finish, ms);
        timer.unref?.();
        signal.addEventListener("abort", finish, { once: true });
        function finish(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolveWait();
        }
    });
}

async function safeDispatchEvent(bridge: ConductorSessionBridge, event: unknown): Promise<void> {
    try {
        await bridge.handleEvent(event);
    } catch {
        // Single event failures must not terminate the event subscription loop.
    }
}

async function disposeAll(
    registrations: ReadonlyArray<Registration>,
    eventLoopDone: Promise<void>,
    store: ConductorStateStore,
): Promise<void> {
    await Promise.allSettled([
        ...registrations.map((registration) => registration.dispose()),
        eventLoopDone,
    ]);
    store.clearMemory();
}

function readInvocationText(prompt: unknown): string {
    if (typeof prompt === "string") {
        return prompt;
    }
    return readPromptObjectText(prompt);
}

function readPromptObjectText(prompt: unknown): string {
    if (typeof prompt !== "object" || prompt === null || !("text" in prompt)) {
        return "";
    }
    return typeof prompt.text === "string" ? prompt.text : "";
}
