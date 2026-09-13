---
name: automate
description: Run the SDET pipeline for one approved test case — UI by default, API-only or balanced (frontend + API) when explicitly requested — write -> execute -> route to bug-reporter or code-reviewer.
---

# Automate

Run the full automation pipeline for the approved test case given in the arguments (test case
id/description, plus optional `--type ui|api|balanced` and `--collection <path>` flags).

## 0. Decide scope

`--type` is opt-in for anything beyond plain UI automation — never infer balanced or API scope from
the case description alone:

- No `--type` given → **ui** only. This is the default; do not run the API half unless `--type`
  says so.
- `--type ui` → frontend/UI only (same as the default).
- `--type api` → API only (equivalent to running the `automate-api` skill directly — prefer that
  when the case is *known* to be API-only from the start).
- `--type balanced` → run **both** halves. Only do this when `--type balanced` was explicitly
  given — never default into it.
- `--collection <path>` (a Postman collection, OpenAPI/Swagger spec, or Insomnia export) means the
  API half should be driven from it — pass that path straight to `api-test-writer` rather than
  having it probe the API blind. Only relevant when the API half is actually running (`--type api`
  or `--type balanced`).

## 1. Automate

- **ui** (default, and `--type ui`): run **test-writer** only.
- **api** (`--type api`): run **api-test-writer** only, exactly as the `automate-api` skill does.
- **balanced** (`--type balanced` only): run the **test-writer** agent for the UI half and the
  **api-test-writer** agent for the API half of the *same* approved test case, in the *same*
  Playwright + TypeScript project. They must agree on shared test data rather than each inventing
  its own — e.g. if the UI flow creates a record, the API half verifies that exact record by the ID
  the UI side produced (and vice versa). Each agent: reuses existing conventions, explores/imports
  only what's missing (UI via Playwright snapshots + HAR; API via the provided `--collection` or
  direct probing), implements its half, runs it, and captures debug evidence on failure
  (screenshot/trace/video/HAR for UI; sanitized request/response + trace for API).

## 2. Route the outcome

Combine both halves' results when balanced:
- If either half fails because of a **genuine application defect**, hand the evidence off to the
  **bug-reporter** agent to file one reproducible bug report — note explicitly whether the defect
  showed up on the UI side, the API side, or as a mismatch between what the UI displays and what
  the API actually returns.
- If **all relevant halves pass**, hand the new/changed automation code off to the **code-reviewer**
  agent to review before it's considered mergeable.

## 3. Report

Report back a single summary covering every half that ran: what was written for each, whether the
targeted test(s) and regression suite passed, and the outcome of whichever follow-up agent ran.
Never report success by having weakened or changed the approved test's intent.

## 4. Record the run

Set `MSYS_NO_PATHCONV=1` (Git Bash otherwise mangles the leading `/` in `--command` into a path —
see `automation-knowledge/failures/FL-001.md`) and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline automate --command "<exactly how this was invoked, e.g. '/automate TC-102 --type balanced'>" --agents <test-writer-and/or-api-test-writer>,<bug-reporter-or-code-reviewer> --status <pass|fail|blocked> --summary "<one-line outcome>"`
(list only the agents actually used — e.g. `test-writer,api-test-writer,code-reviewer` for a
balanced pass, or just `api-test-writer,bug-reporter` for an `--type api` failure).
Let it auto-detect changed files from git; only pass `--files-added/--files-modified/--files-deleted`
explicitly if this isn't a git repo or the auto-detected list needs correcting. If **bug-reporter**
ran, add `--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from its §5 output (its
per-run bug-list refresh) so the execution log shows what changed in the bug list, not just this
run's outcome. Mention the updated `.lastrun.json` in the final summary.
