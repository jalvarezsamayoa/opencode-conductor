import { z } from "zod";
import type { ConductorOptions, ModelRef } from "../core/types.js";

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_BLOCKED_PLAN_TOOLS: ReadonlyArray<string> = ["write", "edit", "patch", "execute"];
export const DEFAULT_PROMPT_SHELL_IN_PLAN_MODE = true;

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/**
 * Checks whether a model identifier segment is non-empty and free of whitespace or control chars.
 */
export function isCleanModelToken(value: string): boolean {
    return value.length > 0 && !/\s/.test(value) && !hasControlCharacter(value);
}

const ModelTokenSchema = z.string().trim().min(1).refine(isCleanModelToken, {
    message: "Model token must not contain whitespace or control characters.",
});

const ModelRefObjectSchema = z.object({
    providerID: ModelTokenSchema,
    id: ModelTokenSchema,
    variant: ModelTokenSchema.optional(),
});

const PositiveIntSchema = z.number().int().min(1);
const BlockedToolsSchema = z.array(z.string().min(1));

/**
 * Parses `"provider/model"` or `"provider/model#variant"` using OpenCode's Model.Ref.parse rules.
 */
export function parseModelRef(rawInput: string): ModelRef {
    const trimmed = rawInput.trim();
    if (!isCleanModelToken(trimmed)) {
        throw new Error(`Invalid model reference: ${rawInput}`);
    }
    const providerEnd = trimmed.indexOf("/");
    if (providerEnd <= 0) {
        throw new Error(`Invalid model reference: ${rawInput}`);
    }
    const providerID = trimmed.slice(0, providerEnd);
    if (providerID.includes("#")) {
        throw new Error(`Invalid model reference: ${rawInput}`);
    }
    return buildValidatedModelRef(trimmed, providerID, providerEnd, rawInput);
}

function buildValidatedModelRef(
    trimmed: string,
    providerID: string,
    providerEnd: number,
    rawInput: string,
): ModelRef {
    const variantStart = trimmed.indexOf("#", providerEnd + 1);
    const modelID = trimmed.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
    const variant = variantStart === -1 ? undefined : trimmed.slice(variantStart + 1);
    if (!isValidModelParts(modelID, variant)) {
        throw new Error(`Invalid model reference: ${rawInput}`);
    }
    return variant === undefined
        ? { providerID, id: modelID }
        : { providerID, id: modelID, variant };
}

function isValidModelParts(modelID: string, variant: string | undefined): boolean {
    if (modelID.length === 0) {
        return false;
    }
    if (variant === undefined) {
        return true;
    }
    return variant.length > 0 && !variant.includes("#");
}

/**
 * Formats a ModelRef back into `"provider/model"` or `"provider/model#variant"`.
 */
export function formatModelRef(model: ModelRef): string {
    const base = `${model.providerID}/${model.id}`;
    return model.variant ? `${base}#${model.variant}` : base;
}

/**
 * Compares two ModelRef objects for exact provider, model id, and variant equality.
 */
export function modelsEqual(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
    if (!left || !right) {
        return left === right;
    }
    return left.providerID === right.providerID
        && left.id === right.id
        && left.variant === right.variant;
}

function parseModelCandidate(rawValue: unknown): ModelRef {
    if (typeof rawValue === "string") {
        return parseModelRef(rawValue);
    }
    const parsed = ModelRefObjectSchema.parse(rawValue);
    return parsed.variant === undefined
        ? { providerID: parsed.providerID, id: parsed.id }
        : { providerID: parsed.providerID, id: parsed.id, variant: parsed.variant };
}

function parseOptionalModelField(
    rawValue: unknown,
    fieldName: string,
    warnings: string[],
): ModelRef | undefined {
    if (rawValue === undefined) {
        return undefined;
    }
    try {
        return parseModelCandidate(rawValue);
    } catch {
        warnings.push(`Invalid "${fieldName}" model configuration ignored.`);
        return undefined;
    }
}

function parseMaxFailures(rawValue: unknown): number {
    const result = PositiveIntSchema.safeParse(rawValue);
    return result.success ? result.data : DEFAULT_MAX_CONSECUTIVE_FAILURES;
}

function parseBlockedTools(rawValue: unknown): ReadonlyArray<string> {
    const result = BlockedToolsSchema.safeParse(rawValue);
    return result.success ? [...result.data] : [...DEFAULT_BLOCKED_PLAN_TOOLS];
}

function parsePromptShell(rawValue: unknown): boolean {
    const result = z.boolean().safeParse(rawValue);
    return result.success ? result.data : DEFAULT_PROMPT_SHELL_IN_PLAN_MODE;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerantly parses plugin options from `opencode.jsonc`, falling back safely on invalid fields.
 */
export function parseConductorOptions(rawOptions: unknown): ConductorOptions {
    const record = isPlainRecord(rawOptions) ? rawOptions : {};
    const warnings: string[] = [];
    const planner = parseOptionalModelField(record.planner, "planner", warnings);
    const executor = parseOptionalModelField(record.executor, "executor", warnings);

    return {
        ...(planner ? { planner } : {}),
        ...(executor ? { executor } : {}),
        maxConsecutiveFailures: parseMaxFailures(record.maxConsecutiveFailures),
        blockedPlanTools: parseBlockedTools(record.blockedPlanTools),
        promptShellInPlanMode: parsePromptShell(record.promptShellInPlanMode),
        ...(warnings.length > 0 ? { configWarning: warnings.join(" ") } : {}),
    };
}
