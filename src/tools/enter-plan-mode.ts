import { z } from "zod";
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool";
import type { PlanReviewInput } from "../core/protocol-messages.js";
import { ENTER_PLAN_TOOL } from "../core/tool-guard.js";

export const EnterPlanModeSchema = z.object({
    reason: z.string().min(1, "Reason must be a non-empty string.").max(4_000),
    completedSteps: z.array(z.string().max(1_000)).max(100).default([]),
    blocker: z.string().max(4_000).optional(),
    verificationOutput: z.string().max(20_000).optional(),
});

export type EnterPlanModeHandler = (
    sessionID: string,
    reviewInput: PlanReviewInput,
) => Promise<{ readonly content: string }>;

/**
 * Creates the `enter_plan_mode` tool definition registered with `codemode: false`.
 */
export function createEnterPlanModeTool(
    onEnterPlanMode: EnterPlanModeHandler,
): ToolInfo<typeof EnterPlanModeSchema, undefined> {
    return {
        name: ENTER_PLAN_TOOL,
        description: "Return control from the Execution model back to the Planning model when a re-plan trigger or blocker occurs.",
        input: EnterPlanModeSchema,
        options: { codemode: false },
        execute: async (
            rawInput: z.infer<typeof EnterPlanModeSchema>,
            toolContext: Pick<ToolContext, "sessionID">,
        ) => {
            const parsed = EnterPlanModeSchema.parse(rawInput);
            return onEnterPlanMode(toolContext.sessionID, {
                reason: parsed.reason,
                completedSteps: parsed.completedSteps,
                blocker: parsed.blocker,
                verificationOutput: parsed.verificationOutput,
            });
        },
    };
}
