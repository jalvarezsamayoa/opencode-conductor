# opencode-conductor

`opencode-conductor` (`opencode-conductor` plugin ID) adds bidirectional two-phase Planner and Executor model switching inside a single OpenCode 2 session.
A session starts in a read-only `PLANNING` phase on your planning model, hands off an ordered plan contract via `exit_plan_mode` to your faster execution model, and switches back to `PLANNING` automatically or via `enter_plan_mode` when work fails, stalls, or completes.

## Requirements

- Node.js `>= 24`
- `@opencode/plugin` `>= 2.3.0` (built and verified against `@opencode/plugin@2.4.1`)

## Installation and OpenCode Setup

Install dependencies and build the package:

```sh
npm install && npm run build
```

Register the package directory in your OpenCode configuration (`opencode.jsonc`) under `plugins` using the object form with `package` and `options`.
Point OpenCode at the package directory rather than a bare `.js` file so OpenCode loads `package.json` and resolves compiled ESM modules from `dist/`.

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-conductor",
      "options": {
        "executor": "google/gemini-4-hydrogen",
        "planner": "google/gemini-4-neon",
        "maxConsecutiveFailures": 3,
        "blockedPlanTools": ["write", "edit", "patch", "execute"],
        "promptShellInPlanMode": true
      }
    }
  ]
}
```

## Configuration Options

Options are parsed from the `options` field of the plugin entry in `opencode.jsonc`.
Invalid option values fall back to safe defaults and attach a warning shown by `/conductor status`.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `planner` | `"provider/model[#variant]"` or `{ providerID, id, variant? }` | Current session model on `/conductor on` | Model used during read-only `PLANNING`. |
| `executor` | `"provider/model[#variant]"` or `{ providerID, id, variant? }` | `undefined` (must be set in config or via `/conductor <provider>/<model>`) | Model switched to during `EXECUTING`. |
| `maxConsecutiveFailures` | Positive integer (`>= 1`) | `3` | Consecutive failing tool outcomes in the active execution epoch before Conductor switches back to `PLANNING` automatically. |
| `blockedPlanTools` | `string[]` (non-empty strings) | `["write", "edit", "patch", "execute"]` | Tool names stripped from context and blocked during active `PLANNING`. |
| `promptShellInPlanMode` | `boolean` | `true` | Downgrades `"allow"` permissions for `"shell"` to `"ask"` during active `PLANNING` while preserving `"deny"`. |

Model strings accept `"provider/model"` and optional `"#variant"` fragments.
Whitespace and control characters are rejected.

## Commands

Conductor is opt-in per session via `/conductor`:

- `/conductor` or `/conductor status`: Prints whether Conductor is active, current phase (`PLANNING` or `EXECUTING`), paused status, `phaseEpoch`, configured `planner` and `executor` models, failure count, and any configuration warning.
- `/conductor on`: Enables Conductor on the active session, snapshots the current session model as `planner` if `planner` was not configured, enters `PLANNING`, and ensures an `executor` model is available.
- `/conductor off`: Restores the `planner` model if currently `EXECUTING` and clears Conductor state from the session.
- `/conductor <provider>/<model>[#<variant>]`: Sets or overrides the session `executor` model without editing `opencode.jsonc`, enabling Conductor in `PLANNING` if it was disabled.

## Custom Tools

Both tools register with `options: { codemode: false }` and are only runnable in their matching phase:

### `exit_plan_mode`

Callable only during active unpaused `PLANNING`.
Arguments:

- `plan` (`string`, required, 1 to 100,000 characters): Ordered implementation steps.
- `verification` (`string[]`, optional, up to 50 items of 1 to 2,000 characters, default `[]`): Verification commands to run after edits.
- `rePlanIf` (`string[]`, optional, up to 50 items of 1 to 2,000 characters, default `[]`): Conditions that require handing control back to `PLANNING`.

Calling `exit_plan_mode` switches the session model to `executor`, advances `phaseEpoch`, transitions state to `EXECUTING`, and records a same-message fence so sibling mutating tool calls emitted in that assistant turn stay blocked until the next turn's `session.hook("context")`.

### `enter_plan_mode`

Callable only during active unpaused `EXECUTING`.
Arguments:

- `reason` (`string`, required, 1 to 4,000 characters): Why planning review is needed.
- `completedSteps` (`string[]`, optional, up to 100 items of up to 1,000 characters, default `[]`): Steps already finished.
- `blocker` (`string`, optional, up to 4,000 characters): Blocking discrepancy or failure.
- `verificationOutput` (`string`, optional, up to 20,000 characters): Relevant check output.

Calling `enter_plan_mode` switches back to `planner`, transitions to `PLANNING`, and returns the structured `[plan review]` payload directly as the tool result for the Planner turn.

## Read-Only Gate and Automatic Hand-Backs

While a session is enabled and unpaused in `PLANNING`, Conductor enforces a three-layer read-only gate:

1. Context filtering (`session.hook("context")`): Removes tools in `blockedPlanTools` and removes `enter_plan_mode`, leaving `exit_plan_mode` available.
2. Pre-execution blocking (`tool.hook("execute.before")`): Rejects calls to `blockedPlanTools`, `enter_plan_mode`, or any tool invoked with `codemode: true`, including sibling calls from the assistant message that invoked `exit_plan_mode`.
3. Permission downgrade (`permission.hook("evaluate")`): Downgrades `"shell"` permission effects from `"allow"` to `"ask"` when `promptShellInPlanMode` is enabled, while preserving `"deny"`.

Automatic transitions from `EXECUTING` back to `PLANNING` happen when:

- Consecutive tool failures (error outcomes or `shell` completion output ending with a non-zero `Exit code: N`) reach `maxConsecutiveFailures`, capped at one automatic hand-back per turn.
- A non-synthetic user prompt arrives during execution (`applyRealUserPrompt`), which switches back to `PLANNING` with a static interruption note.
- OpenCode emits `session.execution.failed`, `session.execution.interrupted`, or `session.experimental.idle` with no session-owned background tasks remaining.

If the user switches models manually via OpenCode's model picker while Conductor is active, Conductor pauses automatic phase switching until the user returns or runs `/conductor on`.

## Development

```sh
npm test
npm run test:coverage
npm run typecheck
npm run lint
npm run build
```

See [docs/architecture.md](docs/architecture.md) for the module layout, concurrency model, and security boundaries.

## License

GNU General Public License v3.0 ([LICENSE](LICENSE)).
