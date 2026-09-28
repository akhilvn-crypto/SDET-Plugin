---
name: sdet
description: Spec-aware test management around the existing pipeline — discover specifications (or explore autonomously when there are none), explore the app, generate traceable test cases, create/update only the Playwright automation that is missing or affected, execute, persist state, and report Spec -> Test Case -> Automation -> Result. Idempotent across runs.
---

# SDET — spec-aware pipeline

A test-management layer **around** the existing agents. It does not replace them: exploration and
test authoring are still done by `test-writer` / `api-test-writer` / `visual-test-writer`, execution
and diagnosis by `test-runner`, defects by `bug-reporter`, review by `code-reviewer`. What this
skill adds is *which* work to do, and a durable record of what has already been done.

Arguments (all optional):

| Argument | Effect |
|---|---|
| *(none)* | Discover specs under the configured roots and process each. With no specs at all (or `spec.enabled: false`), fall back to autonomous mode. |
| `--spec <path>` (repeatable; file or folder) | Process only these. Takes precedence over discovery. A folder is searched recursively. |
| `--explore [<area or URL>]` | Autonomous mode — no spec. |
| `--list` | Show discovered specs and their automation state, then stop. Read-only. |
| `--report [<ID>...]` | Print the lifecycle report from stored state, then stop. Read-only. |
| `--dry-run` | Discover and print the plan (what would be created/updated/skipped), change nothing. |
| `--ui=true\|false`, `--api=true\|false`, `--visual=true\|false` | Choose which automation layers run (§3.5), for this run only. |
| `--collection <path>` | Drive the API layer from a Postman / OpenAPI / Insomnia file (sets `api.collection`). Only used when the API layer is on. |
| `--security=true\|false`, `--accessibility=true\|false`, `--set <key>=<value>` | Override `sdet.config.json` for this run only. |

Every automation run goes through this command. There is no separate single-case command: to
automate or re-automate specific cases, use `--spec` for their spec. A case already marked
`Needs Update` or `Not Automated` is picked up automatically.

## 0. The tool, and the rules it enforces

All deterministic work goes through one script. From the project root:

```
SDET='node "${CLAUDE_PLUGIN_ROOT}/scripts/sdet.js"'
```

Pass every runtime override from the arguments (`--ui=…`, `--api=…`, `--visual=…`,
`--collection …`, `--security=…`, `--accessibility=…`, `--set …`) through to **every** `$SDET` call
in this run, so the whole run sees one configuration. Resolve it
once up front and keep it in view:

```
$SDET config show <overrides>
```

If it reports no project `sdet.config.json`, say so once ("running on plugin defaults — create one
with `/sdet-config init`") and continue; configuration is never a blocker.

Non-negotiables for this whole skill:

- **Never write to state files by hand.** `.sdet/state.json`, `.sdet/snapshots/`, `.sdet/history/`
  and the script-managed test-case fields (`automation`, `last_execution`) change only through
  `$SDET`. You author test-case *content*; the script owns tracking.
- **Identity is the spec `id`, never the filename.** Never create a second record, test-case file,
  or spec file for an id that already exists.
- **Config gates coverage.** When `testing.security` is false: no security test cases, no security
  automation, no security results in the report. Same for `testing.accessibility` (and it is
  *off* unless the config says `true` — a spec's `accessibility_checks` never turns it on).
  `$SDET` enforces this on validation, run arguments, ingestion and reporting; you enforce it on
  what you ask agents to do.
- **Never convert a spec straight into Playwright code.** The application is explored before any
  detailed test case or automation is written.
- **A failing test is not a reason to edit it.** Diagnose first (§6).

## 1. Read-only modes

- `--list` → run `$SDET specs list`, show the table, stop.
- `--report` → run `$SDET report [<ID>...]`, show it, stop.
- `--dry-run` → run `$SDET specs discover [--spec …]` and, for each spec, state what §2 would do
  (and for a CHANGED spec, `$SDET specs diff <ID>`). Stop without writing anything.

None of these need an execution-log entry.

## 2. Discover and plan

Run `$SDET specs discover [--spec <path>]...`. If `--explore` was given, or discovery ran in
`discovered` mode and found **no** spec files (or reports mode `disabled`), go to §8 autonomous mode.

Act on each classification:

| Classification | Action |
|---|---|
| `NEW` | Full workflow (§3). |
| `RESUME` | Full workflow, resuming: reuse whatever already exists (test-case file, automation) and pick up from the recorded stage — never regenerate finished work. |
| `CHANGED` | Delta workflow (§4). If it is also moved, the commit records the new path. |
| `MOVED` | `$SDET state relocate <ID>`, then treat as `UNCHANGED`. Test cases and automation are kept as they are. |
| `UNCHANGED` | No generation. Apply `execution.onUnchanged`: `skip` → report only; `verify` → `$SDET trace <ID>`; if it reports errors (automation missing/untagged), resume at §3 step 5 for just those cases, otherwise report "unchanged — no duplication"; `run` → §3 steps 7–10 only. |
| `MISSING_ID` | Safe migration — never assign silently. Show the file and the suggested id (the script reuses an id already tracked for that path or content before inventing one) and ask the user to confirm or supply one (`AskUserQuestion`). On confirmation run `$SDET specs assign-id <file> --id <ID>`, then re-run discovery for that file. If declined, skip it and say so. |
| `DUPLICATE_ID` | Do not process either file. Report both paths; ask the user which one owns the id. |
| `INVALID` | Do not process. Report the parse error. |
| `MISSING` (state record, no file) | Report only. Never delete its state, test cases or automation — it may have been moved outside the spec roots. |

Surface every `warning:` line (e.g. content changed without a version bump) in the final report.

Process specs **one at a time**, completing each before starting the next.

## 3. Full workflow (NEW / RESUME)

**1. Understand the spec.** Read the whole file. Extract the objective and scope, the scenarios /
requirements, the entry point, test-data *references* (env var names — never values), and — only
for dimensions enabled in the resolved config — `security_checks` / `accessibility_checks`.
`$SDET state stage <ID> DISCOVERED --spec <path from discovery>` (pinning the file matters for specs
outside `spec.roots`; later calls find it from state).

**2. Explore the application.** Invoke **test-writer** in **explore-only mode** (its §0a) with: the
spec id, entry point, objective, the scenario list, and which of security/accessibility are enabled.
It reuses `automation-knowledge/exploration/` first, explores only what is missing, persists what it
learns, and returns a structured summary of what actually exists: pages and navigation, forms and
inputs, buttons/links, dialogs, validation and error messages, success states, redirects,
authentication/authorisation behaviour, dynamic content, security-relevant behaviour (if enabled),
accessibility characteristics (if enabled), and any place where the application contradicts the
spec. When `testing.api` is true, also ask **api-test-writer** to probe the endpoints behind these
flows (its §7). Then `$SDET state stage <ID> EXPLORED --note "<one line: what was explored>"`.
If the application cannot be reached, `$SDET state stage <ID> BLOCKED --note "<why>"`, report it, and
move on — never generate test cases from the spec alone.

**3. Generate test cases.** `$SDET testcases init <ID>` creates (or keeps) the document; its path is
printed by `$SDET testcases path <ID>`. Author it — see §5 for the structure and the rules. Base
every case on **both** the spec (what must be true) and the exploration (how the app actually does
it). Then loop `$SDET testcases validate <ID>` until it prints `OK`, and
`$SDET testcases render <ID>` for the human-review Markdown.
`$SDET state stage <ID> TEST_CASES_GENERATED`

**4. Detect existing automation before writing any.** Run `$SDET trace <ID>`, and search the test
suite for flows these cases cover that are *not yet tagged* (grep the page/feature names from the
exploration). If an existing test already proves a case, the case is adopted: test-writer adds the
tags to that test instead of writing a second one. Never duplicate a test that exists.

**5. Automate what is missing.** Collect the Active cases whose `automation_status` is
`Not Automated` or `Needs Update` (and whose dimension is enabled). Hand them to the authoring
agents for each **enabled automation layer**, passing the test-case file path and the explicit list
of TC ids. The layers come from the resolved config (`testing.ui`, `testing.api`, `testing.visual`),
never from how a case is worded:
- `testing.ui` → **test-writer** (automation mode, §0a) for the UI half. `API`-type cases are not
  given to it.
- `testing.api` → **api-test-writer** (traceability rules in its §10) for the API half of the same
  cases, plus every `API`-type case. If `api.collection` is set, pass that path so it imports (its
  §6) and sanitises only the endpoints these cases need, never the whole collection, and flags
  anything that looks like a real secret instead of writing it anywhere. Without a collection it follows its §7 exploration order.
- `testing.visual` → **visual-test-writer** for the visual half: full-page and component baselines
  in a `visual` project inside the *same* `playwright.config.ts`.

When more than one layer runs, all halves share one Playwright + TypeScript project and must
agree on test data: whichever half creates a record, the others use its id (the API half checks
the exact record the UI half created, and the visual half reuses the UI half's `storageState`, data,
navigation and Page Objects). If every layer is off, generate and commit the test cases but mark
this step skipped in the report. An `API`-type case with the API layer off stays `Not Automated`,
and a UI-only case with the UI layer off does the same.

Each test must carry the traceability tags `@<SPEC_ID>` and `@<TC_ID>` (plus `@security` /
`@accessibility` for those types). Afterwards run `$SDET trace <ID> --write` — it must exit 0 (every
case that should be automated is found by tag, no unknown tags, type tags present). Hand any error
back to the agent that wrote the test. For cases now automated after `Needs Update`, run
`$SDET testcases set-status <ID> --tc <TC,...> --status Automated`. A case that genuinely cannot be
automated (manual-only judgement, e.g. screen-reader experience) is set to `Manual` with a reason in
its objective — never silently dropped.
`$SDET state stage <ID> AUTOMATION_GENERATED`

**6. Execute** (when `execution.runAfterGenerate` is true). Get the exact command from
`$SDET run-args <ID>` (for a delta, `$SDET run-args --tc <affected TC ids>`). It scopes by tag,
excludes disabled dimensions, and writes a JSON report to `.sdet/results/last-run.json` alongside the
project's normal artifacts. Have **test-runner** run that exact command and diagnose every failure
with the existing taxonomy (`automation-knowledge/failures/README.md`). Then:
- `$SDET results ingest` — maps results back to test cases via tags.
- For every failed case: `$SDET results classify <TC_ID> <CATEGORY>` with test-runner's category.
  The report rolls categories up as Application Defect / Test Defect / Automation-Locator Issue /
  Environment Issue / Test Data Issue / Unknown.
- `APPLICATION_DEFECT` (or a genuine `VISUAL_REGRESSION`) → **bug-reporter** files it; then
  `$SDET results classify <TC_ID> APPLICATION_DEFECT --issue <BUG-ID>`. The test stays as written.
  When more than one layer ran, tell bug-reporter where the defect showed up: the UI side, the API
  side, or a mismatch between them. For a visual regression, pass the expected, actual and diff
  images along with visual-test-writer's description of what changed.
- A visual diff classified as an **intended change** is not a bug. Put visual-test-writer's
  `/update-baselines` proposal in the report and leave the baseline alone, so a human decides.
- Automation-side failures → back to the authoring agent to fix the root cause (never by weakening
  an assertion, skipping, or adding sleeps), re-run once via the same `run-args` command, re-ingest.
- Environment / test-data failures → report; do not touch the test.
`$SDET state stage <ID> EXECUTED`

**7. Review.** When the relevant tests pass (or fail only on genuine application defects), hand the
new/changed automation from every layer that ran to **code-reviewer** before it counts as mergeable.

**8. Commit.** `$SDET state commit <ID>`. It validates the test cases again, syncs the automation
mapping from the tags, snapshots the spec (for the next change diff), archives this test-case
version, computes the new/updated/unchanged/obsoleted delta, and sets `AUTOMATED` or
`AUTOMATION_INCOMPLETE`. Fix and re-commit on any error; surface its warnings.

## 4. Delta workflow (CHANGED)

1. `$SDET specs diff <ID>` — requirement-level delta (items added/removed per section, changed
   fields) plus a line diff against the **last processed** version.
2. Map the delta onto the existing cases (match on `spec_scenario` / `req_id`):
   - **Added requirement** → new cases, numbered after the highest existing TC number (ids are never
     reused or renumbered).
   - **Removed requirement** → its cases become `status: "Obsolete"`, `automation_status:
     "Obsolete"`. Never delete a case from the file — validation rejects that.
   - **Changed requirement / changed objective, entry point, or test-data reference** → update only
     the affected cases' content and set their `automation_status` to `Needs Update`.
   - **Everything else stays byte-for-byte unchanged.**
3. Explore only the affected functionality (test-writer explore-only, scoped to the added/changed
   items), then `$SDET state stage <ID> EXPLORED --note "delta: <items>"`.
4. Bump `meta.version` (minor, e.g. `1.0` → `1.1`), append a `meta.changelog` entry naming exactly
   what changed, add a `release_history` row. Validate and render as in §3.3.
5. Automate only `Not Automated` / `Needs Update` cases; ask test-writer to **remove** the automated
   tests of obsoleted cases (found by tag) — `$SDET trace <ID>` warns while any remain. Then §3.5's
   trace/`set-status` steps.
6. Execute only the affected cases: `$SDET run-args --tc <new + updated TC ids>`, then §3.6–3.8.

## 5. Test-case structure (qa-analyst shape)

One JSON document per spec id at `<paths.testCases>/<SPEC_ID>.test-cases.json`, shaped after the
qa-analyst plugin's `TestCaseDocument` — `meta`, `test_cases`, `not_covered`, `document_control`,
`release_history` — with each case extended for spec traceability and automation state:

```json
{
  "tc_id": "MAGENTO-LOGIN-001-TC03",
  "req_id": "MAGENTO-LOGIN-001",
  "spec_id": "MAGENTO-LOGIN-001",
  "spec_scenario": "invalid password",
  "title": "Login is rejected with an invalid password",
  "objective": "Verify that a registered username with a wrong password cannot sign in.",
  "test_type": "Negative",
  "priority": "High",
  "preconditions": "A registered account exists (LOGIN_USERNAME).",
  "steps": [
    { "step_number": 1, "action": "Open the login page", "expected_result": "The sign-in form is shown", "test_data": "" },
    { "step_number": 2, "action": "Enter the registered username", "expected_result": "The username is accepted", "test_data": "env:LOGIN_USERNAME" },
    { "step_number": 3, "action": "Enter an incorrect password and submit", "expected_result": "An invalid-credentials error is shown and the user stays on the login page", "test_data": "any value other than LOGIN_PASSWORD" }
  ],
  "security_relevance": "None",
  "accessibility_relevance": "None",
  "automation_status": "Not Automated",
  "status": "Active"
}
```

- `meta`: `spec_id`, `spec_version`, `source_doc`, `source` (`spec` | `autonomous`), `version`
  (`"1.0"` on first generation), `generated_date`, `changelog[]` (`{version, date, changes}`,
  append-only).
- `document_control` / `release_history`: as in qa-analyst. Unknown values stay
  `"TBD – Client/Project Input Required"` — never invented. `reasons` ≤ 120 characters.
- `not_covered[]`: `{req_id, reason}` for any spec requirement you could not turn into a case (e.g.
  the application lacks the feature, or the spec is too ambiguous to state an expected result). A
  requirement never appears silently in neither list.
- `req_id`: the requirement the case traces to — a scenario-level id if the spec gives its items
  ids, otherwise the spec id. `spec_scenario` quotes the spec item verbatim (this is what the delta
  workflow matches on).
- `test_type`: `Positive`, `Negative`, `Validation`, `Boundary`, `Edge`, `Permission`, `Integration`,
  `Security`, `Accessibility`, `Database`, `API`.
- `priority`: `High` / `Medium` / `Low` — from the spec's own priority if it states one; otherwise
  core happy paths and security High, validation/negative Medium, cosmetic/edge Low.
- `security_relevance` / `accessibility_relevance`: one short phrase, or `"None"`.
- `automation_status`: `Not Automated` → `Automated` (set by `trace --write`), `Needs Update` (you,
  on a change), `Manual`, `Blocked`, `Obsolete`.

Authoring rules (the qa-analyst generation discipline, applied to specs):
- **Coverage, not quota.** One Positive case per scenario's primary flow; Negative/Validation only
  for rules the spec states or the exploration actually observed (a real error message, a real
  required-field marker); Boundary only for stated limits; Edge only for foreseeable states. Merge
  scenarios that are genuinely one check. No redundant cases (validation warns on duplicate titles).
- **Atomic steps.** One action, one specific verifiable expected result. "Works correctly" is never
  an expected result.
- **Never invent test data or behaviour.** Reference env var names; keep wording general where the
  spec and the app are both silent. Never write a real credential into a case.
- **Spec vs application.** Where the spec assumes an implementation detail the app does differently
  (field names, navigation), follow the app. Where the app contradicts the spec's *expected
  behaviour*, the case asserts the spec's behaviour and the contradiction is called out in the
  report as a probable defect — never quietly rewrite the expectation to match the app.
- **Security** (only when enabled): non-destructive checks grounded in what this flow exposes —
  authentication validation, authorisation boundaries, session handling, sensitive-data exposure,
  password handling, error-message disclosure, input validation, unexpected redirects, basic access
  control. Nothing destructive, no load, nothing outside the application's authorised scope
  (`security.authorizedHosts`, else the configured base URL).
- **Accessibility** (only when enabled): the spec's `accessibility_checks`, plus baseline checks for
  the flow even if the spec is silent — one automated-scan case per distinct page/state (a single
  scan covers many controls), and targeted cases only where behaviour needs dedicated proof
  (keyboard operability and tab order, visible focus, modal focus trap/restoration, accessible names
  and label association, error association, status announcements). Only for functionality where it
  is relevant.
- Security- and accessibility-focused cases use those `test_type`s so the config gate can find
  them; a functional case can still note `security_relevance` without becoming a Security case.

## 6. Failure handling

Classification is test-runner's job, using the existing categories; this skill only records it.
Never modify a test simply because it failed, never re-record a visual baseline to clear a failure
(that is `/update-baselines`, human-confirmed), and never report a case green by weakening it.

## 7. Report

Print `$SDET report <processed IDs>`, then add, in plain words: per spec, what was classified and
what was done (created / updated / unchanged — "no duplication" for an unchanged spec), any spec vs
application contradictions, bugs filed, anything skipped and why (missing id declined, duplicate id,
blocked environment), and every warning. Disabled dimensions are reported only as `Disabled`, never
with findings. An automated accessibility scan is reported as exactly that — never as WCAG
compliance.

## 8. Autonomous mode (no spec)

The existing exploration behaviour, wrapped in the same bookkeeping:

1. **test-writer** explore-only from the base URL (or the `--explore` area/URL): identify the
   meaningful user workflows, reusing `automation-knowledge/exploration/`.
2. For each workflow worth covering (at most `autonomous.maxAreas` per run, most business-critical
   first), use a stable id `<autonomous.idPrefix>-<AREA>` (e.g. `AUTO-CHECKOUT`). If `$SDET specs
   list` already shows that id, it is an existing area — treat it like an UNCHANGED/RESUME spec, not
   a new one.
3. `$SDET state stage <ID> DISCOVERED --source autonomous --name "<area>"`, then
   `... EXPLORED --source autonomous`, `$SDET testcases init <ID> --source autonomous --name "<area>"`.
4. Generate functional cases from what the exploration observed (same structure and rules as §5,
   `req_id` = the area id, `spec_scenario` = the observed workflow), plus security / accessibility
   cases only if enabled.
5. Continue with §3 steps 4–8 unchanged.

## 9. Record the run

Set `MSYS_NO_PATHCONV=1` and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline sdet --command "<exactly how this was invoked, e.g. '/sdet --spec specs/auth/login.yaml'>" --agents <agents actually used, comma-separated> --status <pass|fail|blocked> --summary "<n specs: x new, y changed, z unchanged; tests p/f>" --specs <processed spec/area ids, comma-separated>`,
listing only the agents actually used (e.g. `test-writer,api-test-writer,test-runner,code-reviewer`).
Let it auto-detect changed files from git. Pass `--files-added/--files-modified/--files-deleted`
yourself only when this isn't a git repo or the detected list is wrong. If bug-reporter ran, add
`--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from its §5 output. Mention the updated
`.lastrun.json` and `.sdet/state.json` in the final summary. (`--list`, `--report` and `--dry-run`
runs are exempt.)
