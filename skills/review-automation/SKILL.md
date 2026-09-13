---
name: review-automation
description: Review Playwright + TypeScript automation code quality (defaults to uncommitted changes).
---

# Review Automation

Use the **code-reviewer** agent to review: the given file/directory path, or the current
uncommitted changes (`git diff`) if none was given.

Report findings ranked Blocking / Should fix / Nice to have, each anchored to a file/line with the
concrete failure scenario and fix, per the agent's scoped checklist (stack compliance, secrets/HAR
leak risk, POM/convention adherence, locator robustness, waits/determinism, assertion quality,
debug-artifact config, reuse vs. duplication, maintainability).

Then record the run: set `MSYS_NO_PATHCONV=1` and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline review-automation --command "<exactly how this was invoked, e.g. '/review-automation src/tests'>" --agents code-reviewer --status <pass|fail-review> --summary "<counts by severity>"`,
letting it auto-detect changed files from git. Mention the updated `.lastrun.json` in the report.
