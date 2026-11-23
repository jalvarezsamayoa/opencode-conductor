# Architecture

`opencode-conductor` orchestrates two-phase model switching inside a single OpenCode 2 session using `@opencode/plugin` lifecycle hooks, custom tools, persistent session storage, and a narrow event subscription loop.

## Module Map

Source files live under `src/`:

- `src/index.ts`: Exports `Plugin.define({ id: "opencode-conductor", setup: setupConductorPlugin })`.
- `src/config/options.ts`: Validates `ModelRef` strings and objects (`isCleanModelToken`, `parseModelRef`, `modelsEqual`, `parseConductorOptions`) with fallback defaults and warnings.
- `src/core/types.ts`: Domain interfaces for `ConductorPhase`, `ModelRef`, `PlanContract`, `SessionConductorState`, `ConductorOptions`, `TransitionDecision`, and `ToolAccessDecision`.
- `src/core/tool-guard.ts`: Stateless three-layer access evaluator (`filterToolsForContext`, `evaluateToolAccess`, `evaluateShellPermission`).
- `src/core/protocol-messages.ts`: Formats `<conductor_protocol>`, `<active_plan>`, `<plan_review>`, and status notices, and sanitizes untrusted text via `neutralizeProtocolTags`.
- `src/core/phase-machine.ts`: Pure state transition functions (`prepareExitPlanMode`, `prepareEnterPlanMode`, `evaluateToolOutcome`, `isToolExecutionFailure`, `applyRealUserPrompt`, `applyManualModelSelection`, `prepareSilentPlanningRestore`).
- `src/core/state-store.ts`: In-memory cache backed by cursor-paginated `storage.scan` hydration, strict `JsonValue` serialization, FIFO per-session mutex (`runExclusive`), pending switch tracking, call-epoch attribution, and same-message `exit_plan_mode` fencing.
- `src/tools/exit-plan-mode.ts`: Registers `exit_plan_mode` with bounded Zod schema (`ExitPlanModeSchema`) and `codemode: false`.
- `src/tools/enter-plan-mode.ts`: Registers `enter_plan_mode` with bounded Zod schema (`EnterPlanModeSchema`) and `codemode: false`.
- `src/commands/conductor-command.ts`: Parses and executes `/conductor` subcommands inside per-session locks (`parseConductorCommandArgs`, `executeConductorCommand`).
- `src/host/session-bridge.ts`: Connects OpenCode hooks, tools, and events to `ConductorStateStore` and `phase-machine.ts` (`ConductorSessionBridge`).
- `src/host/plugin.ts`: Registers hooks and transforms, runs the reconnect-capable event loop (`SUBSCRIBED_EVENTS`), and coordinates clean teardown (`disposeAll`).

## State Machine and Concurrency

Each tracked session holds either `{ enabled: false }` or an `EnabledConductorState` with:

- `phase`: `"PLANNING"` or `"EXECUTING"`.
- `paused`: Set `true` when `session.model.selected` does not match a Conductor-initiated switch, halting automatic enforcement until the user selects the active phase model again or runs `/conductor on`.
- `phaseEpoch`: Monotonically increments on every phase transition so in-flight tool outcomes started in an earlier epoch are ignored by `evaluateToolOutcome`.
- `consecutiveToolFailures` and `autoHandbacksThisTurn`: Track failures inside the current epoch and cap automatic steering hand-backs at one per user turn.

`ConductorStateStore` serializes all state-mutating operations per `sessionID` through a FIFO promise chain (`lockTails` + `createReleaseGate`).
`set` and `deleteSession` write to or remove from OpenCode `context.storage` before committing the in-memory map update so storage errors never leave memory ahead of disk.
At plugin startup, `hydrate()` scans keys prefixed with `conductor:session:` page by page using `after` cursors, validates persisted objects with `PersistedEnabledStateSchema`, and deletes empty or corrupted keys.

## Three-Layer Read-Only Gate and Same-Message Fence

During unpaused `PLANNING`, `ConductorSessionBridge` and `tool-guard.ts` enforce read-only behavior across three independent hook boundaries:

1. `session.hook("context")`: Filters out `blockedPlanTools` and `enter_plan_mode`, keeps `exit_plan_mode` visible, injects `formatPlanningSystemMessage`, and clears `pendingInterruptionNote`.
2. `tool.hook("execute.before")`: Blocks `blockedPlanTools`, `enter_plan_mode`, and any `codemode === true` call.
3. `permission.hook("evaluate")`: Downgrades `"shell"` from `"allow"` to `"ask"` when `promptShellInPlanMode` is true, leaving `"deny"` untouched.

When `exit_plan_mode` completes mid-turn, `handleExitPlanMode` records its `messageID` via `store.markExitPlanMessage(sessionID, messageID)`.
Both `handleBeforeTool` and `handlePermissionEvaluate` consult `resolveBeforeToolState(sessionID, messageID, state)`, which treats that `messageID` as still in `PLANNING` even after state switches to `EXECUTING`.
That prevents batched sibling mutating tools or `"allow"` shell calls in the same assistant message from bypassing the gate before the next `session.hook("context")` clears the fence.

## Security and Reliability Boundaries

- Linear-time tag sanitization: `PROTOCOL_TAG_PATTERN` in `src/core/protocol-messages.ts` uses `/<\s*(?:\/\s*)?(?:conductor_protocol|active_plan|plan_review)\b(?:[^>]*>)?/gi` to escape complete, truncated, or whitespace-padded structural tags in `O(n)` time without overlapping whitespace quantifiers (preventing CWE-1333 backtracking).
- Secret and prompt isolation: Auto-handback failure notices include only the sanitized tool name and failure count rather than raw tool stdout/stderr, real-user interruptions record a static `USER_INTERRUPTION_NOTE` instead of raw user prompts, `/conductor` usage help does not echo unrecognized user arguments, and `/conductor off` returns a static warning if planner restoration fails.
- Anchored shell failure detection: OpenCode reports non-zero shell exits as `status: "completed"` with `"Exit code: <N>"` appended to output, so `phase-machine.ts` matches `/(?:^|\r?\n)Exit code:\s*([1-9]\d*)\r?\s*$/` at the end of the tool outcome text.
- Event scoping and reconnects: `src/host/plugin.ts` subscribes only to `SUBSCRIBED_EVENTS` (`session.deleted`, `session.created`, `session.forked`, `session.execution.failed`, `session.execution.interrupted`, `session.model.selected`), reconnects after stream errors with exponential backoff from `25ms` to `2000ms`, ignores events whose non-empty `location.directory` or `workspaceID` mismatches the plugin context, and deletes tracked state for `session.deleted` or foreign-descendant `session.forked` / `session.created` events (`parentID !== sessionID`) without altering the parent session.
- Deterministic teardown: `disposeAll` awaits hook disposals and `eventLoopDone` before clearing in-memory store maps.
