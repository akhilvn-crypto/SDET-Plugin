---
name: runtest
description: Execute the existing Playwright suite (or a subset) and diagnose any failures via test-runner.
---

# Runtest

## 1. Identify the runner

Before executing anything, ask the user (e.g. via `AskUserQuestion`) who is running this test and
their role — a name and a role/designation (e.g. "QA Engineer", "Developer", "Manual Tester").
Carry their answers forward as `--runner-name "<name>"` and `--runner-role "<role>"` on the
`record-run.js` call below — this always overrides whatever `config/authors.json` would have
auto-detected, since the user told us directly this time.

## 2. Run the tests

Use the **test-runner** agent to execute: the given scope (a file path, `@tag`, or the full suite
if no argument was given).

Report pass/fail counts, classify every failure per its diagnosis rules (locator / assertion /
timing / auth / test-data / environment / network-API / visual regression / genuine app defect /
flakiness), and list the path to each failure's screenshot/trace/video/HAR. Flag anything that
looks like a genuine application defect so it can be routed to the **bug-reporter** agent next,
rather than fixed as if it were an automation bug.

**Projects using `/sdet` (an `sdet.config.json` at the root).** Honour its testing toggles: get the
command from `node "${CLAUDE_PLUGIN_ROOT}/scripts/sdet.js" run-args [<SPEC_ID>...] [--tc <TC ids>]`
(a spec id or test-case id scope maps to those; for the full suite pass no ids; for a file or other
`@tag` scope, append that scope to the command it prints) so tests of a disabled security or
accessibility dimension are excluded, and hand that exact command to **test-runner**. Afterwards
update the test cases with the outcome:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/sdet.js" results ingest` records each case's execution status,
  test status and (for passes, skips and flaky passes) actual result.
- For every failed or flaky case, `... results classify <TC_ID> <CATEGORY> --actual "<test-runner's
  ACTUAL RESULT line>"` — plain words a business reader understands, never the raw error.
- For every genuine application defect, route to **bug-reporter** (it files a new bug, or bumps /
  regresses the existing one for that case), then record its `TEST CASE UPDATE` line with
  `... results classify <TC_ID> APPLICATION_DEFECT --issue BUG-<NNN> --actual "..."` so the test
  case links to the bug file. A previously linked bug whose case now passes is re-checked by
  bug-reporter (Fixed); the link stays on the test case and shows the bug's new status.
- `... results pending` must print `OK` before you report.

Without an `sdet.config.json`, run exactly as below.

If the project has a `visual` Playwright project, it runs with the rest of the suite unless the
scope says otherwise (`--project=visual` runs it alone). A `toHaveScreenshot` mismatch is a
`VISUAL_REGRESSION`, not a locator failure: report the expected/actual/diff artifact paths and
route it to the **visual-test-writer** agent to review the images and decide whether it's a real
regression, an intended design change, or harness noise. Never clear one by re-recording a
baseline — that's `/update-baselines`, and it needs a human.

## 3. Record the run

Set `MSYS_NO_PATHCONV=1` and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline runtest --command "<exactly how this was invoked, e.g. '/runtest @smoke'>" --agents test-runner --status <pass|fail> --summary "<pass/fail counts + one-line outcome>" --runner-name "<name from step 1>" --runner-role "<role from step 1>"`,
letting it auto-detect changed files from git (pass `--files-*` flags explicitly only if this
isn't a git repo or a fix was applied directly). If a follow-up `bug-reporter` triage ran against
this run's failures, add `--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from its §5
output. Mention the updated `.lastrun.json` in the report.
