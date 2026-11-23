import { z } from "zod";
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool";
import { EXIT_PLAN_TOOL } from "../core/tool-guard.js";
import type { PlanContract } from "../core/types.js";

export const ExitPlanModeSchema = z.object({
    plan: z.string().min(1, "Plan must be a non-empty string.").max(100_000),
    verification: z.array(z.string().min(1).max(2_000)).max(50).default([]),
    rePlanIf: z.array(z.string().min(1).max(2_000)).max(50).default([]),
});

export type ExitPlanModeHandler = (
    sessionID: string,
    contract: PlanContract,
    messageID: string,
) => Promise<{ readonly content: string }>;

/**
 * Creates the `exit_plan_mode` tool definition registered with `codemode: false`.
 */
export function createExitPlanModeTool(
    onExitPlanMode: ExitPlanModeHandler,
): ToolInfo<typeof ExitPlanModeSchema, undefined> {
    return {
        name: EXIT_PLAN_TOOL,
        description: "Hand control from the read-only Planning phase to the Execution model with an ordered plan.",
        input: ExitPlanModeSchema,
        options: { codemode: false },
        execute: async (
            rawInput: z.infer<typeof ExitPlanModeSchema>,
            toolContext: Pick<ToolContext, "sessionID" | "messageID">,
        ) => {
            const parsed = ExitPlanModeSchema.parse(rawInput);
            return onExitPlanMode(
                toolContext.sessionID,
                {
                    planText: parsed.plan,
                    verificationChecks: parsed.verification,
                    replanTriggers: parsed.rePlanIf,
                },
                toolContext.messageID,
            );
        },
    };
}
