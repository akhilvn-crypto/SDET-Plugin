---
name: regression
description: Execute the existing Playwright suite (or a subset) and diagnose any failures via test-runner.
---

# Regression

Use the **test-runner** agent to execute: the given scope (a file path, `@tag`, or the full suite
if no argument was given).

Report pass/fail counts, classify every failure per its diagnosis rules (locator / assertion /
timing / auth / test-data / environment / network-API / genuine app defect / flakiness), and list
the path to each failure's screenshot/trace/video/HAR. Flag anything that looks like a genuine
application defect so it can be routed to the **bug-reporter** agent next, rather than fixed as if
it were an automation bug.

Then record the run: set `MSYS_NO_PATHCONV=1` and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline regression --command "<exactly how this was invoked, e.g. '/regression @smoke'>" --agents test-runner --status <pass|fail> --summary "<pass/fail counts + one-line outcome>"`,
letting it auto-detect changed files from git (pass `--files-*` flags explicitly only if this
isn't a git repo or a fix was applied directly). If a follow-up `bug-reporter` triage ran against
this run's failures, add `--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from its §5
output. Mention the updated `.lastrun.json` in the report.
