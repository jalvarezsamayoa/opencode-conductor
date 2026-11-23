import { z } from "zod";
import { isCleanModelToken, modelsEqual } from "../config/options.js";
import type { EnabledConductorState, ModelRef, SessionConductorState } from "./types.js";

export const STORAGE_KEY_PREFIX = "conductor:session:";
const PENDING_SWITCH_TTL_MS = 5_000;

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | { readonly [key: string]: JsonValue }
    | ReadonlyArray<JsonValue>;

export interface StorageEntry {
    readonly key: string;
    readonly value: JsonValue;
}

export interface StorageBackend {
    readonly get: (key: string) => Promise<JsonValue | undefined>;
    readonly set: (key: string, value: JsonValue) => Promise<void>;
    readonly remove: (key: string) => Promise<void>;
    readonly scan: (options: {
        readonly prefix: string;
        readonly after?: string;
    }) => Promise<{ readonly entries: ReadonlyArray<StorageEntry>; readonly next?: string | undefined }>;
}

const ModelTokenSchema = z.string().trim().min(1).refine(isCleanModelToken);

const ModelRefSchema = z.object({
    providerID: ModelTokenSchema,
    id: ModelTokenSchema,
    variant: ModelTokenSchema.optional(),
});

const PlanContractSchema = z.object({
    planText: z.string().min(1).max(100_000),
    verificationChecks: z.array(z.string().max(2_000)).max(50),
    replanTriggers: z.array(z.string().max(2_000)).max(50),
});

const PersistedEnabledStateSchema = z.object({
    enabled: z.literal(true),
    paused: z.boolean(),
    phase: z.enum(["PLANNING", "EXECUTING"]),
    phaseEpoch: z.number().int().min(0),
    plannerModel: ModelRefSchema,
    executorModel: ModelRefSchema,
    activeContract: PlanContractSchema.optional(),
    pendingInterruptionNote: z.string().max(1_000).optional(),
    consecutiveToolFailures: z.number().int().min(0),
    autoHandbacksThisTurn: z.number().int().min(0),
});

interface PendingModelSwitch {
    readonly model: ModelRef;
    readonly expiresAt: number;
}

/**
 * In-memory and persistent per-session Conductor state store with serialized per-session mutex.
 */
export class ConductorStateStore {
    private readonly sessions = new Map<string, SessionConductorState>();
    private readonly lockTails = new Map<string, Promise<void>>();
    private readonly pendingSwitches = new Map<string, PendingModelSwitch[]>();
    private readonly callEpochs = new Map<string, Map<string, number>>();
    private readonly exitPlanMessages = new Map<string, string>();
    private readonly storage: StorageBackend;

    constructor(storage: StorageBackend) {
        this.storage = storage;
    }

    get(sessionID: string): SessionConductorState {
        return this.sessions.get(sessionID) ?? { enabled: false };
    }

    async set(sessionID: string, state: SessionConductorState): Promise<void> {
        if (!state.enabled) {
            await this.deleteSession(sessionID);
            return;
        }
        await this.storage.set(storageKey(sessionID), serializeEnabledState(state));
        this.sessions.set(sessionID, state);
    }

    async deleteSession(sessionID: string): Promise<void> {
        await this.storage.remove(storageKey(sessionID));
        this.sessions.delete(sessionID);
        this.pendingSwitches.delete(sessionID);
        this.callEpochs.delete(sessionID);
        this.exitPlanMessages.delete(sessionID);
    }

    async deleteIfTracked(sessionID: string): Promise<void> {
        if (!this.sessions.has(sessionID)) {
            return;
        }
        await this.deleteSession(sessionID);
    }

    clearMemory(): void {
        this.sessions.clear();
        this.lockTails.clear();
        this.pendingSwitches.clear();
        this.callEpochs.clear();
        this.exitPlanMessages.clear();
    }

    async hydrate(): Promise<void> {
        let after: string | undefined;
        do {
            after = await this.hydratePage(after);
        } while (after !== undefined);
    }

    private async hydratePage(after: string | undefined): Promise<string | undefined> {
        const result = await this.storage.scan(buildScanOptions(after));
        for (const entry of result.entries) {
            await this.hydrateEntry(entry);
        }
        return !result.next || result.next === after ? undefined : result.next;
    }

    private async hydrateEntry(entry: StorageEntry): Promise<void> {
        if (!entry.key.startsWith(STORAGE_KEY_PREFIX)) {
            return;
        }
        const sessionID = entry.key.slice(STORAGE_KEY_PREFIX.length);
        const parsed = PersistedEnabledStateSchema.safeParse(entry.value);
        if (sessionID.length === 0 || !parsed.success) {
            await this.storage.remove(entry.key);
            return;
        }
        this.sessions.set(sessionID, normalizePersistedState(parsed.data));
    }

    async runExclusive<ResultType>(
        sessionID: string,
        operation: () => Promise<ResultType>,
    ): Promise<ResultType> {
        const previous = this.lockTails.get(sessionID) ?? Promise.resolve();
        const gate = createReleaseGate();
        const tail = previous.then(() => gate.promise);
        this.lockTails.set(sessionID, tail);
        await previous;
        try {
            return await operation();
        } finally {
            gate.release();
            if (this.lockTails.get(sessionID) === tail) {
                this.lockTails.delete(sessionID);
            }
        }
    }

    recordPendingSwitch(sessionID: string, model: ModelRef, now = Date.now()): void {
        const queue = this.pruneExpiredSwitches(sessionID, now);
        queue.push({ model, expiresAt: now + PENDING_SWITCH_TTL_MS });
        this.pendingSwitches.set(sessionID, queue);
    }

    removePendingSwitch(sessionID: string, model: ModelRef): void {
        const queue = this.pendingSwitches.get(sessionID);
        if (!queue) {
            return;
        }
        const matchIndex = queue.findIndex((entry) => modelsEqual(entry.model, model));
        if (matchIndex !== -1) {
            queue.splice(matchIndex, 1);
        }
        this.deleteQueueIfEmpty(sessionID, queue);
    }

    consumePendingSwitch(sessionID: string, model: ModelRef, now = Date.now()): boolean {
        if (!this.pendingSwitches.has(sessionID)) {
            return false;
        }
        const queue = this.pruneExpiredSwitches(sessionID, now);
        const matchIndex = queue.findIndex((entry) => modelsEqual(entry.model, model));
        if (matchIndex === -1) {
            this.deleteQueueIfEmpty(sessionID, queue);
            return false;
        }
        queue.splice(matchIndex, 1);
        this.deleteQueueIfEmpty(sessionID, queue);
        return true;
    }

    trackCallEpoch(sessionID: string, callID: string, epoch: number): void {
        let sessionCalls = this.callEpochs.get(sessionID);
        if (!sessionCalls) {
            sessionCalls = new Map<string, number>();
            this.callEpochs.set(sessionID, sessionCalls);
        }
        sessionCalls.set(callID, epoch);
    }

    takeCallEpoch(sessionID: string, callID: string): number | undefined {
        const sessionCalls = this.callEpochs.get(sessionID);
        if (!sessionCalls) {
            return undefined;
        }
        const epoch = sessionCalls.get(callID);
        sessionCalls.delete(callID);
        return epoch;
    }

    clearCallEpochs(sessionID: string): void {
        this.callEpochs.delete(sessionID);
    }

    markExitPlanMessage(sessionID: string, messageID: string): void {
        this.exitPlanMessages.set(sessionID, messageID);
    }

    isExitPlanMessage(sessionID: string, messageID: string): boolean {
        return this.exitPlanMessages.get(sessionID) === messageID;
    }

    clearExitPlanMessage(sessionID: string): void {
        this.exitPlanMessages.delete(sessionID);
    }

    private pruneExpiredSwitches(sessionID: string, now: number): PendingModelSwitch[] {
        const existing = this.pendingSwitches.get(sessionID);
        if (!existing) {
            return [];
        }
        const active = existing.filter((entry) => entry.expiresAt >= now);
        this.deleteQueueIfEmpty(sessionID, active);
        return active;
    }

    private deleteQueueIfEmpty(sessionID: string, queue: PendingModelSwitch[]): void {
        if (queue.length === 0) {
            this.pendingSwitches.delete(sessionID);
        } else {
            this.pendingSwitches.set(sessionID, queue);
        }
    }
}

function createReleaseGate(): { readonly promise: Promise<void>; readonly release: () => void } {
    let releaseCallback: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        releaseCallback = resolve;
    });
    return { promise, release: releaseCallback };
}

function buildScanOptions(after: string | undefined): { readonly prefix: string; readonly after?: string } {
    return after === undefined
        ? { prefix: STORAGE_KEY_PREFIX }
        : { prefix: STORAGE_KEY_PREFIX, after };
}

function storageKey(sessionID: string): string {
    return `${STORAGE_KEY_PREFIX}${sessionID}`;
}

function serializeEnabledState(state: EnabledConductorState): JsonValue {
    return {
        enabled: true,
        paused: state.paused,
        phase: state.phase,
        phaseEpoch: state.phaseEpoch,
        plannerModel: serializeModelRef(state.plannerModel),
        executorModel: serializeModelRef(state.executorModel),
        ...(state.activeContract ? { activeContract: serializeContract(state.activeContract) } : {}),
        ...(state.pendingInterruptionNote !== undefined
            ? { pendingInterruptionNote: state.pendingInterruptionNote }
            : {}),
        consecutiveToolFailures: state.consecutiveToolFailures,
        autoHandbacksThisTurn: state.autoHandbacksThisTurn,
    };
}

function serializeModelRef(model: ModelRef): JsonValue {
    return model.variant === undefined
        ? { providerID: model.providerID, id: model.id }
        : { providerID: model.providerID, id: model.id, variant: model.variant };
}

function serializeContract(contract: NonNullable<EnabledConductorState["activeContract"]>): JsonValue {
    return {
        planText: contract.planText,
        verificationChecks: [...contract.verificationChecks],
        replanTriggers: [...contract.replanTriggers],
    };
}

function normalizePersistedState(
    parsed: z.infer<typeof PersistedEnabledStateSchema>,
): EnabledConductorState {
    return {
        enabled: true,
        paused: parsed.paused,
        phase: parsed.phase,
        phaseEpoch: parsed.phaseEpoch,
        plannerModel: normalizeModelRef(parsed.plannerModel),
        executorModel: normalizeModelRef(parsed.executorModel),
        ...(parsed.activeContract ? { activeContract: parsed.activeContract } : {}),
        ...(parsed.pendingInterruptionNote ? { pendingInterruptionNote: parsed.pendingInterruptionNote } : {}),
        consecutiveToolFailures: parsed.consecutiveToolFailures,
        autoHandbacksThisTurn: parsed.autoHandbacksThisTurn,
    };
}

function normalizeModelRef(model: z.infer<typeof ModelRefSchema>): ModelRef {
    return model.variant === undefined
        ? { providerID: model.providerID, id: model.id }
        : { providerID: model.providerID, id: model.id, variant: model.variant };
}
