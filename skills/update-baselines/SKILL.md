---
name: update-baselines
description: Regenerate Playwright visual baselines after a human has confirmed the diffs are intended — review every diff first, refuse on a genuine regression, update only the confirmed scope, then prove green.
---

# Update Baselines

Regenerate the committed visual baselines for the scope given in the arguments (no argument =
the whole `visual` project; otherwise a spec path, a test title, or a named snapshot).

Re-recording a baseline overwrites the repo's record of what "correct" looks like, so this is the
one visual operation a human invokes deliberately — the `visual-test-writer` agent may only
*propose* it, never perform it.

## 1. Show what will change, before changing anything

Run the visual project **without** any update flag first:
`npx playwright test --project=visual` (scoped to the argument, if one was given).

- If everything passes, there is nothing to update. Say so and stop — do not re-record baselines
  that already match.
- For every failing snapshot, use the **visual-test-writer** agent's §10 diff review: read the
  `*-expected.png`, `*-actual.png` and `*-diff.png` artifacts and classify each one as
  **Intended change**, **Genuine regression**, or **Harness noise**.

Present the list to the user: one row per snapshot — file, diff ratio, what changed in words, and
the verdict.

## 2. Refuse on anything that isn't an intended change

- Any snapshot classified a **genuine regression** blocks the update. Do not proceed for that
  snapshot; route it to the **bug-reporter** agent with the three PNGs as evidence instead. A
  regression is not a baseline problem.
- Any snapshot classified **harness noise** should be fixed in the harness (mask, settle signal,
  font/animation pinning) and re-run — not baked into a new baseline.
- Proceed only with the snapshots the user explicitly confirms are intended. If the user asks to
  update everything including a regression, say plainly what would be enshrined as correct and
  get an explicit confirmation of that specific snapshot before doing it.

## 3. Update the confirmed scope only

Run `npx playwright test --project=visual --update-snapshots` scoped as narrowly as the
confirmation allows (a spec path or `-g "<test title>"`), never wider. Then:

- Open each regenerated PNG and confirm it shows the intended state, not a mid-load or error page.
- Confirm no regenerated baseline renders a secret, token, or real personal data.
- Re-run **without** `--update-snapshots` and confirm the visual project is green.

## 4. Report and record the run

Report: which snapshots were reviewed, each verdict, which were regenerated, which were refused
and why, any bug handed to **bug-reporter**, and the final green/red state of the visual project.

Then set `MSYS_NO_PATHCONV=1` (Git Bash otherwise mangles the leading `/` in `--command` into a
path — see `automation-knowledge/failures/FL-001.md`) and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline update-baselines --command "<exactly how this was invoked, e.g. '/update-baselines tests/dashboard.visual.spec.ts'>" --agents visual-test-writer<,bug-reporter-if-it-ran> --status <pass|fail|blocked> --summary "<n baselines updated, m refused>"`.
Let it auto-detect changed files from git — the regenerated `.png` baselines are exactly what
should show up in that list; only pass `--files-added/--files-modified/--files-deleted` explicitly
if this isn't a git repo or the auto-detected list needs correcting. If **bug-reporter** ran, add
`--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from its §5 output. Mention the
updated `.lastrun.json` in the final summary.
