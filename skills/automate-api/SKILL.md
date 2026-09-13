---
name: automate-api
description: Run the API-only automation pipeline for one approved test case (write -> execute -> route to bug-reporter or code-reviewer), optionally driven from a provided Postman/OpenAPI/Insomnia collection.
---

# Automate API

Run the API-only automation pipeline for the approved test case given in the arguments (test case
id/description, plus optional `--collection <path>`).

Use this when the test case is genuinely API-only (no UI assertion needed). For the normal
case — a test that should cover both frontend and API — use the `automate` skill instead, which is
balanced by default.

1. Use the **api-test-writer** agent to automate it end to end: detect or extend the shared
   Playwright + TypeScript project, reuse existing API clients/fixtures/conventions, import and
   sanitize the collection at `--collection <path>` if one was given (translating only the
   endpoint(s) this test case needs — never dump an entire collection into tests unasked; flag
   anything in it that looks like a real secret rather than writing it anywhere), implement the
   API test, run it, and capture debug evidence (sanitized request/response, trace) on failure.
2. Based on the outcome:
   - If it fails because of a **genuine API defect**, hand the evidence off to the **bug-reporter**
     agent to file a reproducible bug report.
   - If it **passes**, hand the new/changed automation code off to the **code-reviewer** agent to
     review before it's considered mergeable.
3. Report back a single summary: what was written (and what was imported from the collection, if
   any), whether the targeted test and regression suite passed, and the outcome of whichever
   follow-up agent ran. Never report success by having weakened or changed the approved test's
   intent.
4. Record the run: set `MSYS_NO_PATHCONV=1` (Git Bash otherwise mangles the leading `/` in
   `--command` into a path — see `automation-knowledge/failures/FL-001.md`) and run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline automate-api --command "<exactly how this was invoked, e.g. '/automate-api TC-201'>" --agents api-test-writer,<bug-reporter-or-code-reviewer> --status <pass|fail|blocked> --summary "<one-line outcome>"`.
   Let it auto-detect changed files from git; only pass `--files-added/--files-modified/--files-deleted`
   explicitly if this isn't a git repo or the auto-detected list needs correcting. If
   **bug-reporter** ran, add `--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from its
   §5 output so the execution log shows what changed in the bug list. Mention the updated
   `.lastrun.json` in the final summary.
