import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import ConductorPlugin from "../../src/index.js";

interface MockSessionRecord {
    id: string;
    model?: { providerID: string; id: string; variant?: string } | undefined;
}

type HookHandler = (input: unknown) => Promise<void> | void;

interface MockHarness {
    context: Plugin.Context;
    hooks: Map<string, HookHandler>;
    tools: Map<string, { name: string; options?: unknown; execute: (input: unknown, ctx: unknown) => Promise<unknown> }>;
    commands: Map<string, { name: string; execute: (input: unknown) => Promise<void> }>;
    storageMap: Map<string, unknown>;
    registrations: Array<{ dispose: ReturnType<typeof vi.fn> }>;
    sessions: Map<string, MockSessionRecord>;
    switchModel: ReturnType<typeof vi.fn>;
    synthetic: ReturnType<typeof vi.fn>;
    subscribeCalls: Array<unknown>;
    emitEvent: (event: Record<string, unknown>) => Promise<void>;
    waitForEvents: () => Promise<void>;
}

function createEventQueue() {
    const queue: Array<Record<string, unknown>> = [];
    let notify: (() => void) | undefined;
    let closed = false;
    return {
        push(event: Record<string, unknown>) {
            queue.push(event);
            notify?.();
            notify = undefined;
        },
        close() {
            closed = true;
            notify?.();
            notify = undefined;
        },
        async *iterate(signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
            while (!closed && !signal?.aborted) {
                if (queue.length > 0) {
                    yield queue.shift()!;
                    continue;
                }
                await new Promise<void>((resolve) => {
                    notify = resolve;
                    signal?.addEventListener("abort", () => resolve(), { once: true });
                });
            }
        },
    };
}

function createMockPluginContext(
    options: Record<string, unknown> = {},
    initialStorage: Array<[string, unknown]> = [],
): MockHarness {
    const hooks = new Map<string, HookHandler>();
    const tools = new Map<string, { name: string; options?: unknown; execute: (input: unknown, ctx: unknown) => Promise<unknown> }>();
    const commands = new Map<string, { name: string; execute: (input: unknown) => Promise<void> }>();
    const storageMap = new Map<string, unknown>(initialStorage);
    const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const subscribeCalls: Array<unknown> = [];
    const sessions = new Map<string, MockSessionRecord>([
        ["s1", { id: "s1", model: { providerID: "google", id: "gemini-4-neon" } }],
    ]);
    const events = createEventQueue();
    const makeRegistration = () => {
        const reg = { dispose: vi.fn().mockResolvedValue(undefined) };
        registrations.push(reg);
        return Promise.resolve(reg);
    };
    const switchModel = vi.fn(async ({ sessionID, model }: { sessionID: string; model: MockSessionRecord["model"] }) => {
        const record = sessions.get(sessionID) ?? { id: sessionID };
        record.model = model;
        sessions.set(sessionID, record);
        events.push({ type: "session.model.selected", data: { sessionID, model } });
    });
    const synthetic = vi.fn().mockResolvedValue({});

    const context = {
        options,
        location: { directory: "/tmp/project", project: { directory: "/tmp/project" } },
        storage: {
            get: vi.fn(async (key: string) => storageMap.get(key)),
            set: vi.fn(async (key: string, value: unknown) => { storageMap.set(key, value); }),
            remove: vi.fn(async (key: string) => { storageMap.delete(key); }),
            scan: vi.fn(async ({ prefix }: { prefix: string }) => ({
                entries: [...storageMap.entries()]
                    .filter(([key]) => key.startsWith(prefix))
                    .map(([key, value]) => ({ key, value })),
            })),
        },
        session: {
            get: vi.fn(async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID) ?? { id: sessionID }),
            switchModel,
            synthetic,
            hook: vi.fn((name: string, cb: HookHandler) => {
                hooks.set(`session.${name}`, cb);
                return makeRegistration();
            }),
        },
        tool: {
            transform: vi.fn((cb: (editor: { add: (tool: never) => void }) => void) => {
                cb({ add: (tool: { name: string; options?: unknown; execute: (input: unknown, ctx: unknown) => Promise<unknown> }) => tools.set(tool.name, tool) } as never);
                return makeRegistration();
            }),
            hook: vi.fn((name: string, cb: HookHandler) => {
                hooks.set(`tool.${name}`, cb);
                return makeRegistration();
            }),
        },
        permission: {
            hook: vi.fn((name: string, cb: HookHandler) => {
                hooks.set(`permission.${name}`, cb);
                return makeRegistration();
            }),
        },
        command: {
            transform: vi.fn((cb: (editor: { add: (cmd: never) => void }) => void) => {
                cb({ add: (cmd: { name: string; execute: (input: unknown) => Promise<void> }) => commands.set(cmd.name, cmd) } as never);
                return makeRegistration();
            }),
        },
        event: {
            subscribe: vi.fn((opts?: { signal?: AbortSignal }) => {
                subscribeCalls.push(opts);
                return events.iterate(opts?.signal);
            }),
        },
    } as unknown as Plugin.Context;

    return {
        context,
        hooks,
        tools,
        commands,
        storageMap,
        registrations,
        sessions,
        switchModel,
        synthetic,
        subscribeCalls,
        emitEvent: async (event) => {
            events.push(event);
            await new Promise((resolve) => setTimeout(resolve, 15));
        },
        waitForEvents: async () => new Promise((resolve) => setTimeout(resolve, 15)),
    };
}

function makeBaseTools() {
    return {
        read: { description: "read", input: {} },
        write: { description: "write", input: {} },
        edit: { description: "edit", input: {} },
        shell: { description: "shell", input: {} },
        exit_plan_mode: { description: "exit", input: {} },
        enter_plan_mode: { description: "enter", input: {} },
    };
}

function getSessionModelId(harness: MockHarness, sessionID: string): string | undefined {
    const record = harness.sessions.get(sessionID);
    return record?.model?.id;
}

describe("opencode-conductor plugin lifecycle integration", () => {
    it("AC-11: rolls back state atomically when switchModel throws", async () => {
        const harness = createMockPluginContext({ executor: "google/gemini-4-hydrogen" });
        const cleanup = await ConductorPlugin.setup(harness.context);
        await harness.commands.get("conductor")!.execute({ sessionID: "s1", prompt: { text: "on" } });

        harness.switchModel.mockRejectedValueOnce(new Error("provider down"));
        await expect(
            harness.tools.get("exit_plan_mode")!.execute({ plan: "1. Edit" }, { sessionID: "s1", messageID: "m1" }),
        ).rejects.toThrow("provider down");

        const contextInput = { sessionID: "s1", agent: "build", model: harness.sessions.get("s1")!.model, system: [], messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(contextInput);
        expect(Object.keys(contextInput.tools)).toContain("exit_plan_mode");
        expect(Object.keys(contextInput.tools)).not.toContain("write");
        await cleanup!();
    });

    it("AC-12: serializes concurrent Promise.all tool outcomes cleanly and fences same-message writes", async () => {
        const harness = createMockPluginContext({ executor: "google/gemini-4-hydrogen", maxConsecutiveFailures: 1 });
        const cleanup = await ConductorPlugin.setup(harness.context);
        await harness.commands.get("conductor")!.execute({ sessionID: "s1", prompt: { text: "on" } });

        await harness.tools.get("exit_plan_mode")!.execute({ plan: "1. Edit" }, { sessionID: "s1", messageID: "msg-exit" });
        expect(() => harness.hooks.get("tool.execute.before")!({
            tool: "write", codemode: false, sessionID: "s1", messageID: "msg-exit", id: "same-msg-write",
        })).toThrow("Plan mode is active");
        const permSameMsg: { sessionID: string; action: string; source: { messageID: string }; effect: "allow" | "deny" | "ask" } = {
            sessionID: "s1", action: "shell", source: { messageID: "msg-exit" }, effect: "allow",
        };
        harness.hooks.get("permission.evaluate")!(permSameMsg);
        expect(permSameMsg.effect).toBe("ask");

        const execCtx = { sessionID: "s1", agent: "build", model: harness.sessions.get("s1")!.model, system: [], messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(execCtx);
        const permNextTurn: { sessionID: string; action: string; source: { messageID: string }; effect: "allow" | "deny" | "ask" } = {
            sessionID: "s1", action: "shell", source: { messageID: "msg-2" }, effect: "allow",
        };
        harness.hooks.get("permission.evaluate")!(permNextTurn);
        expect(permNextTurn.effect).toBe("allow");

        await harness.hooks.get("tool.execute.before")!({ tool: "shell", codemode: false, sessionID: "s1", messageID: "msg-2", id: "c1" });
        await harness.hooks.get("tool.execute.before")!({ tool: "shell", codemode: false, sessionID: "s1", messageID: "msg-2", id: "c2" });

        await Promise.all([
            harness.hooks.get("tool.execute.after")!({
                tool: "shell", codemode: false, sessionID: "s1", id: "c1", status: "completed",
                result: { content: [{ type: "text", text: "Exit code: 1" }] },
            }),
            harness.hooks.get("tool.execute.after")!({
                tool: "shell", codemode: false, sessionID: "s1", id: "c2", status: "completed",
                result: { content: [{ type: "text", text: "Exit code: 1" }] },
            }),
        ]);

        const steerCalls = harness.synthetic.mock.calls.filter((call) => call[0]?.delivery === "steer");
        expect(steerCalls).toHaveLength(1);
        await cleanup!();
    });

    it("AC-13: enter_plan_mode returns Tool.Result without duplicate synthetic; failure handback omits raw stderr", async () => {
        const harness = createMockPluginContext({ executor: "google/gemini-4-hydrogen", maxConsecutiveFailures: 2 });
        const cleanup = await ConductorPlugin.setup(harness.context);
        await harness.commands.get("conductor")!.execute({ sessionID: "s1", prompt: { text: "on" } });
        expect(harness.synthetic).toHaveBeenCalledWith(expect.objectContaining({ resume: false, metadata: { conductorSynthetic: true } }));
        harness.synthetic.mockClear();

        await harness.tools.get("exit_plan_mode")!.execute({ plan: "1. Update" }, { sessionID: "s1", messageID: "m1" });
        const reviewResult = await harness.tools.get("enter_plan_mode")!.execute({ reason: "Blocked" }, { sessionID: "s1" }) as { content: string };
        expect(reviewResult.content).toContain("[plan review]");
        expect(harness.synthetic).not.toHaveBeenCalled();

        await harness.tools.get("exit_plan_mode")!.execute({ plan: "2. Retry" }, { sessionID: "s1", messageID: "m2" });
        await harness.hooks.get("tool.execute.before")!({ tool: "shell", codemode: false, sessionID: "s1", messageID: "m3", id: "a1" });
        await harness.hooks.get("tool.execute.after")!({
            tool: "shell", codemode: false, sessionID: "s1", id: "a1", status: "completed",
            result: { content: [{ type: "text", text: "SECRET_TOKEN_LEAK\nExit code: 1" }] },
        });
        await harness.hooks.get("tool.execute.before")!({ tool: "shell", codemode: false, sessionID: "s1", messageID: "m3", id: "a2" });
        await harness.hooks.get("tool.execute.after")!({
            tool: "shell", codemode: false, sessionID: "s1", id: "a2", status: "completed",
            result: { content: [{ type: "text", text: "SECRET_TOKEN_LEAK\nExit code: 2" }] },
        });

        expect(harness.synthetic).toHaveBeenCalledWith(expect.objectContaining({
            sessionID: "s1",
            delivery: "steer",
            resume: true,
            metadata: { conductorSynthetic: true },
        }));
        const steerText = String(harness.synthetic.mock.calls[0]?.[0]?.text ?? "");
        expect(steerText).not.toContain("SECRET_TOKEN_LEAK");
        await cleanup!();
    });

    it("AC-14: correlates self switches, handles prompt interruption note once, and ignores synthetic prompt hooks", async () => {
        const harness = createMockPluginContext({ executor: "google/gemini-4-hydrogen" });
        const cleanup = await ConductorPlugin.setup(harness.context);
        await harness.commands.get("conductor")!.execute({ sessionID: "s1", prompt: { text: "on" } });
        await harness.waitForEvents();

        const manualPlanner = { providerID: "anthropic", id: "claude-opus-4" };
        await harness.emitEvent({ type: "session.model.selected", data: { sessionID: "s1", model: manualPlanner } });

        await harness.tools.get("exit_plan_mode")!.execute({ plan: "1. Edit" }, { sessionID: "s1", messageID: "m1" });
        await harness.waitForEvents();

        await harness.hooks.get("session.prompt")!({ sessionID: "s1", metadata: { conductorSynthetic: true } });
        expect(getSessionModelId(harness, "s1")).toBe("gemini-4-hydrogen");

        await harness.emitEvent({ type: "session.model.selected", data: { sessionID: "s1", model: { providerID: "openai", id: "gpt-5" } } });
        const pausedCtx = { sessionID: "s1", agent: "build", model: manualPlanner, system: [] as Array<{ type: string; text: string }>, messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(pausedCtx);
        expect(Object.keys(pausedCtx.tools)).not.toContain("exit_plan_mode");

        await harness.hooks.get("session.prompt")!({ sessionID: "s1", prompt: { text: "SECRET_USER_TEXT" } });
        expect(harness.switchModel).toHaveBeenLastCalledWith({ sessionID: "s1", model: manualPlanner });

        const firstPlanCtx = { sessionID: "s1", agent: "build", model: manualPlanner, system: [] as Array<{ type: string; text: string }>, messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(firstPlanCtx);
        expect(firstPlanCtx.system[0]?.text).toContain("<plan_review>");
        expect(firstPlanCtx.system[0]?.text).not.toContain("SECRET_USER_TEXT");

        const secondPlanCtx = { sessionID: "s1", agent: "build", model: manualPlanner, system: [] as Array<{ type: string; text: string }>, messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(secondPlanCtx);
        expect(secondPlanCtx.system[0]?.text).not.toContain("<plan_review>");
        await cleanup!();
    });

    it("AC-15: handles idle, interrupted, failed restores, foreign-location events, and session.deleted", async () => {
        const harness = createMockPluginContext({ executor: "google/gemini-4-hydrogen" });
        const cleanup = await ConductorPlugin.setup(harness.context);
        await harness.commands.get("conductor")!.execute({ sessionID: "s1", prompt: { text: "on" } });
        await harness.tools.get("exit_plan_mode")!.execute({ plan: "1. Edit" }, { sessionID: "s1", messageID: "m1" });
        harness.synthetic.mockClear();

        await harness.hooks.get("session.experimental.idle")!({
            sessionID: "s1",
            background: [{ kind: "shell", sessionID: "s1", shellID: "sh1", command: "npm test" }],
        });
        expect(getSessionModelId(harness, "s1")).toBe("gemini-4-hydrogen");

        await harness.hooks.get("session.experimental.idle")!({
            sessionID: "s1",
            background: [{ kind: "shell", sessionID: "child-1", shellID: "sh2", command: "sleep 1" }],
        });
        expect(getSessionModelId(harness, "s1")).toBe("gemini-4-neon");
        expect(harness.synthetic).not.toHaveBeenCalled();

        await harness.tools.get("exit_plan_mode")!.execute({ plan: "2. Edit" }, { sessionID: "s1", messageID: "m2" });
        await harness.emitEvent({ type: "session.execution.failed", location: { directory: "/other/dir" }, data: { sessionID: "s1" } });
        expect(getSessionModelId(harness, "s1")).toBe("gemini-4-hydrogen");

        await harness.emitEvent({ type: "session.execution.interrupted", location: { directory: "/tmp/project" }, data: { sessionID: "s1" } });
        expect(getSessionModelId(harness, "s1")).toBe("gemini-4-neon");

        await harness.emitEvent({ type: "session.deleted", data: { sessionID: "s1" } });
        expect(harness.storageMap.has("conductor:session:s1")).toBe(false);
        await cleanup!();
    });

    it("AC-16: subscribes with types allowlist, hydrates, isolates session.forked without touching parent, and disposes", async () => {
        const harness = createMockPluginContext(
            { executor: "google/gemini-4-hydrogen" },
            [
                ["conductor:session:s-restored", {
                    enabled: true, paused: false, phase: "PLANNING", phaseEpoch: 2,
                    plannerModel: { providerID: "google", id: "gemini-4-neon" },
                    executorModel: { providerID: "google", id: "gemini-4-hydrogen" },
                    consecutiveToolFailures: 0, autoHandbacksThisTurn: 0,
                }],
                ["conductor:session:s-bad", { enabled: true, corrupted: true }],
            ],
        );
        const cleanup = await ConductorPlugin.setup(harness.context);

        expect(harness.subscribeCalls[0]).toMatchObject({
            types: [
                "session.deleted",
                "session.created",
                "session.forked",
                "session.execution.failed",
                "session.execution.interrupted",
                "session.model.selected",
            ],
        });
        expect(harness.storageMap.has("conductor:session:s-bad")).toBe(false);

        await harness.emitEvent({ type: "session.forked", data: { sessionID: "s-fork", parentID: "s-restored" } });
        await harness.emitEvent({ type: "session.created", data: { sessionID: "s-child", parentID: "s-restored" } });
        await harness.emitEvent({
            type: "session.deleted",
            location: {},
            data: { sessionID: "s-restored", location: { directory: "/tmp/other-project" } },
        });

        const restoredCtx = { sessionID: "s-restored", agent: "build", model: { providerID: "google", id: "gemini-4-neon" }, system: [], messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(restoredCtx);
        expect(Object.keys(restoredCtx.tools)).toContain("exit_plan_mode");

        const forkCtx = { sessionID: "s-fork", agent: "build", model: { providerID: "google", id: "gemini-4-neon" }, system: [], messages: [], options: {}, tools: makeBaseTools() };
        await harness.hooks.get("session.context")!(forkCtx);
        expect(Object.keys(forkCtx.tools)).not.toContain("exit_plan_mode");

        await cleanup!();
        for (const registration of harness.registrations) {
            expect(registration.dispose).toHaveBeenCalledTimes(1);
        }
    });

    it("reconnects event subscription after transient stream failure", async () => {
        const harness = createMockPluginContext({ executor: "google/gemini-4-hydrogen" });
        const subscribeSpy = vi.spyOn(harness.context.event, "subscribe").mockImplementationOnce((() => ({
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    throw new Error("transient disconnect");
                },
            }),
        })) as unknown as typeof harness.context.event.subscribe);

        const cleanup = await ConductorPlugin.setup(harness.context);
        await harness.commands.get("conductor")!.execute({ sessionID: "s1", prompt: { text: "on" } });
        await harness.tools.get("exit_plan_mode")!.execute({ plan: "1. Edit" }, { sessionID: "s1", messageID: "m1" });
        await new Promise((resolve) => setTimeout(resolve, 60));

        await harness.emitEvent({ type: "session.execution.interrupted", data: { sessionID: "s1" } });
        expect(subscribeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(getSessionModelId(harness, "s1")).toBe("gemini-4-neon");
        await cleanup!();
    });
});
