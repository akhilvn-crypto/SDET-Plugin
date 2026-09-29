---
name: sdet
description: Spec-aware test management around the existing pipeline — read a Jira user story into a spec (when Jira is on), discover specifications (or explore autonomously when there are none), explore the app, generate traceable test cases, create/update only the Playwright automation that is missing or affected, execute, persist state, and report Spec -> Test Case -> Automation -> Result. Idempotent across runs.
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
| `--story <KEY>` (repeatable) | Jira mode (`jira.enabled`): read the user story from Jira, analyse it into a spec in the Jira spec folder, then run the full pipeline on that spec (§1a). Genuine defects are filed to Jira and linked to the story (§6a). |
| `--spec <path>` (repeatable; file or folder) | Process only these. Takes precedence over discovery. A folder is searched recursively. |
| `--explore [<area or URL>]` | Autonomous mode — no spec. |
| `--list` | Show discovered specs and their automation state, then stop. Read-only. |
| `--report [<ID>...]` | Print the lifecycle report from stored state, then stop. Read-only. |
| `--dry-run` | Discover and print the plan (what would be created/updated/skipped), change nothing. |
| `--functional=true\|false` (UI), `--api=true\|false`, `--visual=true\|false` | Choose which automation layers run (§3.5), for this run only. |
| `--collection <path>` | Drive the API layer from a Postman / OpenAPI / Insomnia file (sets `api.collection`). Only used when the API layer is on. |
| `--security=true\|false`, `--accessibility=true\|false`, `--set <key>=<value>` | Override `sdet.config.json` for this run only. |
| `--excel` | Also convert each processed spec's test cases to an Excel workbook in the Emvigo controlled-document layout (§3.9). Combined with `--list` or `--report`, it only exports - see §1. |
| `--approve <ID>` (repeatable) | The reviewer has read the pending spec / test cases outside this session and approves them as they are on disk: record it and carry on with that spec (§3a.5). |
| `--review=true\|false` | Turn the human review gates (§3a) on or off for this run only. Default: on (`review.enabled`). |

Every automation run goes through this command. There is no separate single-case command: to
automate or re-automate specific cases, use `--spec` for their spec. A case already marked
`Needs Update` or `Not Automated` is picked up automatically.

**Jira mode gate.** When the resolved config has `jira.enabled: true` and the arguments contain
none of `--story`, `--spec` or `--approve` (and this is not a read-only `--list` / `--report` / `--dry-run`
run), stop before doing anything else and tell the user:

> Jira mode is on — tell me which user story to work on: `/sdet --story PROJ-123`
> (use your project key; several stories: `--story PROJ-123 --story PROJ-124`).
> To re-run specs that already exist, use `/sdet --spec <file or folder>`.

Do not fall back to discovery or autonomous exploration in Jira mode. `--spec` runs (re-running
existing specs, including story specs, for regression) work as usual.

## 0. The tool, and the rules it enforces

All deterministic work goes through one script. From the project root:

```
SDET='node "${CLAUDE_PLUGIN_ROOT}/scripts/sdet.js"'
```

Pass every runtime override from the arguments (`--functional=…`, `--api=…`, `--visual=…`,
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
  and the script-managed test-case fields (`automation`, `last_execution`, `linked_issues`) change
  only through `$SDET`. You author test-case *content*; the script owns tracking.
- **Identity is the spec `id`, never the filename.** Never create a second record, test-case file,
  or spec file for an id that already exists.
- **Config gates coverage.** When `testing.security` is false: no security test cases, no security
  automation, no security results in the report. Same for `testing.accessibility` (and it is
  *off* unless the config says `true` — a spec's `accessibility_checks` never turns it on).
  `$SDET` enforces this on validation, run arguments, ingestion and reporting; you enforce it on
  what you ask agents to do.
- **Never convert a spec straight into Playwright code.** The application is explored before any
  detailed test case or automation is written.
- **A human approves each step before the pipeline acts on it** (§3a): the spec written from a
  Jira story before test cases are generated, the test cases before automation, and each bug
  before it is filed to Jira. Disapproved spec / test cases → ask why, fix, ask again. Declined
  bug → not filed, move on. Only the user's answer counts as approval — never silence, never your
  own judgement that the content is fine. `$SDET` refuses the `AUTOMATION_GENERATED` / `EXECUTED`
  stages, `state commit` and `jira link-bug` while the relevant gate is closed.
- **A failing test is not a reason to edit it.** Diagnose first (§6).
- **Read the Product Catalog first.** Before analysing a story or spec, and in every hand-off to an
  agent, include the Product Catalog: every file in `paths.productCatalog` (default
  `product-catalog/`, main file `PROJECT-CATALOG.md`). It is the project's source of truth for
  environments and URLs, user roles and permissions, test accounts (env var names), modules and
  business rules — use it to resolve what a spec leaves implicit instead of guessing. If it is
  missing or still the empty template, say so once in the report and continue.
- **Jira is reached only through the Atlassian connector** (tools named `…getJiraIssue`,
  `…createJiraIssue`, `…createIssueLink`, `…searchJiraIssuesUsingJql`, `…addCommentToJiraIssue`,
  e.g. `mcp__claude_ai_Atlassian_Rovo__*`; load them with ToolSearch when deferred). Always pass
  `cloudId` = `jira.cloudId`. The script never calls Jira; it records what you fetched and created
  (`$SDET jira …`). If the connector is unavailable in Jira mode, stop and say so — never invent a
  story.

## 1. Read-only modes

- `--list` → run `$SDET specs list`, show the table, stop.
- `--report` → run `$SDET report [<ID>...]`, show it, stop.
- `--dry-run` → run `$SDET specs discover [--spec …]` and, for each spec, state what §2 would do
  (and for a CHANGED spec, `$SDET specs diff <ID>`). Stop without writing anything.

- `--excel` with `--list` → export only: `$SDET testcases export <ID>` for every spec the list shows
  with test cases (or only the `--spec` ones), report the paths, stop. With `--report [<ID>...]`,
  export those ids after printing the report. Nothing is regenerated.

None of these need an execution-log entry.

## 1a. Jira story intake (`--story <KEY>`)

For each story key, one at a time, before discovery:

1. **Fetch.** `getJiraIssue` with `issueIdOrKey: <KEY>`, `fields: ["*all"]` (so custom fields such
   as acceptance criteria come back) and `responseContentFormat: "markdown"`. Also read what
   sharpens the requirement: comments (`fields: ["comment"]` if not included), subtasks, and the
   summaries of directly linked issues (`issuelinks`). Attachments cannot be read through the
   connector — mention any that look like requirements (mock-ups, specs) under Open Questions.
   If the key does not exist or cannot be read, report it and skip it.
2. **Record it.** Write a JSON file to your scratchpad with at least `key`, `summary`, `issuetype`,
   `status`, `updated` (the story's `updated` timestamp, verbatim), `url` (`<jira.siteUrl>/browse/<KEY>`),
   plus `description`, `acceptance_criteria` (if a separate field), `comments`, `subtasks` and
   `links` as fetched. Then `$SDET jira intake <KEY> --file <that file>`. It prints:
   - `NEW` — no spec yet: analyse (step 3) and stamp (step 4).
   - `UPDATED` — the story changed in Jira since its spec was written: re-analyse and stamp; the
     spec version is bumped, so discovery classifies it `CHANGED` and the delta workflow (§4) runs.
   - `UNCHANGED` — the spec already reflects this version of the story: **do not re-analyse**; go
     straight to §2 with `--spec <the printed spec path>` (it is `UNCHANGED` or `RESUME` there).
   Surface every `warning:` (wrong project, not a Story).
3. **Analyse like a BA** (NEW / UPDATED). With the Product Catalog in hand, turn the story into a
   spec body following `${CLAUDE_PLUGIN_ROOT}/templates/spec.jira.template.md`, written as a draft
   file in your scratchpad **without frontmatter**:
   - `## Acceptance Criteria` — one bullet per criterion, `AC1:`, `AC2:` … in the story's order,
     each restated as a verifiable statement. On UPDATED, keep the AC numbering of criteria that
     did not change (read the existing spec first) so the delta maps cleanly. If the story has no
     explicit criteria, derive them from the description and say so under Open Questions.
   - `## Scenarios` — the happy paths, then only the negative / validation / boundary / permission
     scenarios the criteria, the story's comments and the Product Catalog actually imply; each
     tagged with the ACs it proves (`[AC1]`).
   - `## Roles & Access`, `## Business Rules`, `## Entry Point`, `## Test Data` (roles and env
     var names from the Product Catalog — never values), `## Out of Scope`.
   - `## Open Questions` — every gap, ambiguity or contradiction you could not resolve from the
     story, its comments or the catalog. Never fill a gap with an invented rule; the tests assert
     only what the story states. (`- None` when the story is unambiguous.)
   - `## Security Checks` / `## Accessibility Checks` — only when those dimensions are enabled.
4. **Stamp.** `$SDET jira stamp <KEY> --draft <draft file>`. It writes the spec into the Jira spec
   folder (`jira.specFolder`, default `<first spec root>/jira/<KEY>.md`) — or over the existing
   spec for this id wherever it lives — with a script-owned frontmatter (`id: <KEY>`, `version`,
   `name`, `source: jira`, `jira_key`, `jira_url`, `jira_updated`). Never hand-edit that
   frontmatter, and never write the spec file yourself.
   **Review the spec (§3a, gate `spec`)** before going on: the user checks your reading of the
   story — ACs, scenarios, business rules, open questions — while it is still cheap to fix. If
   they disapprove, ask why, apply the corrections to the draft, re-stamp with `--revise` (same
   version) and ask again, until approved. Only then go on to exploration and test-case
   generation. Skipped for `UNCHANGED` stories whose spec was already processed.
5. Continue with §2 using `--spec <that spec path>` for each story. The spec id **is** the story
   key, so test cases are `<KEY>-TC01…`, tests are tagged `@<KEY>` / `@<KEY>-TCnn`, and every
   downstream artefact traces back to the story.

## 2. Discover and plan

Run `$SDET specs discover [--spec <path>]...`. If `--explore` was given, or discovery ran in
`discovered` mode and found **no** spec files (or reports mode `disabled`), go to §8 autonomous mode.

Act on each classification:

| Classification | Action |
|---|---|
| `NEW` | Full workflow (§3). |
| `RESUME` | Full workflow, resuming: reuse whatever already exists (test-case file, automation) and pick up from the recorded stage — never regenerate finished work. Stopped at `AWAITING_APPROVAL` or `CHANGES_REQUESTED` → resume at §3a for the gate `$SDET approval status <ID>` shows closed (apply the recorded corrections first). |
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

**1. Understand the spec.** Read the whole file, and the Product Catalog. Extract the objective and scope, the scenarios /
requirements, the entry point, test-data *references* (env var names — never values), and — only
for dimensions enabled in the resolved config — `security_checks` / `accessibility_checks`. For a
story spec (`source: jira`), the acceptance criteria are the requirements: every AC must end up in
at least one test case or in `not_covered`, and each case's `req_id` is `<KEY>-AC<n>` (the AC it
proves; the first one when it proves several). Open Questions are not requirements — list them in
the report, never turn a guess about them into an expected result.
`$SDET state stage <ID> DISCOVERED --spec <path from discovery>` (pinning the file matters for specs
outside `spec.roots`; later calls find it from state).

**2. Explore the application.** Invoke **test-writer** in **explore-only mode** (its §0a) with: the
spec id, entry point, objective, the scenario list, the Product Catalog path, and which of security/accessibility are enabled.
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

**3b. Human review.** Run §3a with gate `test-cases`. Do not go on until
`$SDET approval check <ID> --gate test-cases` (and `--gate spec` for a story spec) exits 0. If the
user pauses the review, stop here for this spec and move on to the next.

**4. Detect existing automation before writing any.** Run `$SDET trace <ID>`, and search the test
suite for flows these cases cover that are *not yet tagged* (grep the page/feature names from the
exploration). If an existing test already proves a case, the case is adopted: test-writer adds the
tags to that test instead of writing a second one. Never duplicate a test that exists.

**5. Automate what is missing.** Collect the Active cases whose `automation_status` is
`Not Automated` or `Needs Update` (and whose dimension is enabled). Hand them to the authoring
agents for each **enabled automation layer**, passing the test-case file path and the explicit list
of TC ids. The layers come from the resolved config (`testing.functional`, `testing.api`, `testing.visual`),
never from how a case is worded:
- `testing.functional` → **test-writer** (automation mode, §0a) for the UI half. `API`-type cases are not
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
and a UI-only case with the functional (UI) layer off does the same.

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
with the existing taxonomy (`automation-knowledge/failures/README.md`). Then update the test cases
with the outcome — every executed case ends the run with an **Execution Status**, a **Test
Status**, an **Actual Result** and its **Linked Issues**:
- `$SDET results ingest` — maps results back to test cases via tags and records the run. The script
  derives Execution Status (`Executed` / `Not Executed`) and Test Status (`Pass` / `Fail` /
  `Blocked` / `Flaky` / `Not Run`), and writes the actual result for passes, skips and flaky
  passes. A failure's actual result is never guessed from the error; it comes from the diagnosis.
- For every failed or flaky case: `$SDET results classify <TC_ID> <CATEGORY> --actual "<test-runner's
  ACTUAL RESULT line>"`. The actual result is written for business readers: what a person would see,
  no error text, selectors or status codes (the raw error is kept separately as Technical Details).
  A failure classified as an environment, test-data or automation problem becomes `Blocked` — the
  product could not be verified — never `Fail`. The report rolls categories up as Application
  Defect / Test Defect / Automation-Locator Issue / Environment Issue / Test Data Issue / Unknown.
- `APPLICATION_DEFECT` (or a genuine `VISUAL_REGRESSION`) → **bug-reporter** files it (or bumps /
  regresses an existing bug for the same case), passing the TC id and the test-case file so the
  bug links back to it. Then use its `TEST CASE UPDATE` line:
  `$SDET results classify <TC_ID> APPLICATION_DEFECT --issue BUG-<NNN> --actual "<its actual line>"`.
  This links the bug file to the test case (the rendered test case shows the bug's live title and
  status); `--issue` also takes a tracker URL or key, and may be repeated. The test stays as
  written. **When `jira.enabled` is true**, also file it to Jira now — §6a — and add the Jira key as
  a second `--issue` on the same classify call. When more than one layer ran, tell bug-reporter where the defect showed up: the UI side,
  the API side, or a mismatch between them. For a visual regression, pass the expected, actual and
  diff images along with visual-test-writer's description of what changed.
- A visual diff classified as an **intended change** is not a bug. Put visual-test-writer's
  `/update-baselines` proposal in the report and leave the baseline alone, so a human decides.
- Automation-side failures → back to the authoring agent to fix the root cause (never by weakening
  an assertion, skipping, or adding sleeps), re-run once via the same `run-args` command, re-ingest.
- Environment / test-data failures → report; do not touch the test.
- `$SDET results pending <ID>` must print `OK` before moving on: it lists every failure still
  missing a classification or an actual result, and every defect missing its linked bug.
`$SDET state stage <ID> EXECUTED`

**7. Review.** When the relevant tests pass (or fail only on genuine application defects), hand the
new/changed automation from every layer that ran to **code-reviewer** before it counts as mergeable.

**8. Commit.** `$SDET state commit <ID>`. It validates the test cases again, syncs the automation
mapping from the tags, snapshots the spec (for the next change diff), archives this test-case
version, computes the new/updated/unchanged/obsoleted delta, and sets `AUTOMATED` or
`AUTOMATION_INCOMPLETE`. Fix and re-commit on any error; surface its warnings.
Then `$SDET issuelog write <ID>` (see §7a).

**9. Excel export** (only when `--excel` was passed). `$SDET testcases export <ID>` writes
`<SPEC_ID>.test-cases.xlsx` next to the JSON and `.md`: the same three-sheet workbook qa-analyst's
`/generate-test-cases --xlsx` produces (Document Version Control with the project logo from
`Branding/project-logo.png` when present, Document Release History, Test Cases with one row per
case, numbered steps, and the automation/execution columns: Automation Status, Actual Result,
Execution Status, Test Status, Linked Issue). It is built from the same JSON as the `.md`, so the
two always match; it is never read back, so a correction goes in the JSON, not the workbook. Once
it exists, every later re-render (`results ingest`, `results classify`, `testcases render`,
`state commit`, including `/runtest` runs) refreshes it automatically. If a refresh prints
`warning: could not refresh ...` (the file is open in Excel), tell the user to close it and re-run
the export. Also run it for an `UNCHANGED` spec when `--excel` was given - the export is cheap and
needs no regeneration. List every workbook path in the report.

## 3a. Human review gate

The pipeline stops three times for a person, in this order, and each stage only starts once the
one before it is approved:

```
story ─► spec ─[REVIEW spec]─► explore ─► test cases ─[REVIEW test-cases]─► automation ─► run
      ─► bugs ─[REVIEW each bug]─► filed to Jira   (declined bugs are never filed)
```

All on by default (`review.enabled`, `review.spec`, `review.testCases`, `review.bugs` in
`sdet.config.json`; `--review=false` turns them off for one run):

| Gate | What the human reviews | When | If disapproved |
|---|---|---|---|
| `spec` | The spec you wrote from a Jira story (`source: jira`). Hand-written specs are already human-authored — the script reports "no approval needed". | §1a, right after `jira stamp`, before exploring / generating test cases | Ask why, fix, re-review (loop) |
| `test-cases` | The generated test cases (on a delta: only the new / changed ones). | §3 step 3b, §4 step 4, §8 step 4 — before any automation | Ask why, fix, re-review (loop) |
| `bug` | Each local bug, before it is filed to Jira (or added as a new occurrence on an existing Jira bug). | §6a, per bug | Not filed; move on to the next bug (§3a.6) |

An approval is pinned to the content it covered. Any later edit to the spec, a test case's
content or the bug report closes the gate again until it is re-approved; script-managed fields
(automation mapping, results, linked issues, the bug's Jira key) never do. Spec / test-case content
unchanged since the last committed version needs no new approval.

Steps 1–5 below are the loop for the `spec` and `test-cases` gates; step 6 is the bug gate.

**1. Request.** `$SDET approval request <ID> --gate <gate>`. It prints the review round and, on a
re-review, exactly which test cases changed since the last approval.

**2. Present it for review — briefly, in chat.** Don't paste the whole document; give the user what
they need to decide and the file to open for the rest:
- the file to read: the rendered `<ID>.test-cases.md` (or the spec file);
- test cases: a table `TC ID | Title | Type | Priority | Requirement` — on a re-review only the
  changed cases, plus a count of the unchanged ones — then `not_covered`, and every place where
  exploration contradicted the spec;
- spec: the numbered ACs, the scenario list, and the Open Questions;
- any assumption you made that a person should confirm (e.g. which role, which test account).

**3. Ask** with `AskUserQuestion` — one question, header `Review`:
- **Approve** — spec: "Generate test cases from this spec." / test cases: "Automate these as they are."
- **Disapprove** — "Something needs to change — I'll tell you what and why."
- **Review later** — "Pause this spec; I'll review the file and come back."

**4. Act on the answer.**
- **Approve** → `$SDET approval approve <ID> --gate <gate>`. The reviewer's name comes from
  `authors.json` (via `SDET_RUNNER_ID` / git email); if the script can't tell, ask the user's name
  once and pass `--by "<name>"`. For test cases this also fills Reviewed/Approved By/On in the
  current release-history row and the Approved Date, and re-renders the `.md`.
- **Disapprove** →
  1. **Ask why.** Unless the answer's notes already say it, ask in plain text: "What's wrong, and
     what should it say instead?" and wait for the reply. Don't continue without it. If the reason
     is too vague to act on ("TC03 is wrong", "AC2 isn't right"), ask a follow-up about what the
     correct behaviour is — never guess a fix.
  2. **Record it** verbatim: `$SDET approval reject <ID> --gate <gate> --note "<the user's reason
     and corrections>"` (the script refuses without a reason).
  3. **Fix it:**
  - test cases: edit the JSON content only (never script-managed fields); keep TC ids stable —
    add new cases after the highest number, and remove a case outright only if it has never been
    committed (otherwise mark it `Obsolete`). Review rounds do **not** bump `meta.version`; add a
    note to the current changelog entry instead ("review round 2: TC03 expected result corrected").
    Validate and render.
  - spec: rewrite the draft and `$SDET jira stamp <KEY> --draft <file> --revise` (keeps the
    version). If the correction changes requirements, update the affected test cases too.
  - The user may prefer to edit the files themselves: when they say they're done, validate,
    render, and continue.
  4. **Re-review.** Show what changed (a short before → after per touched case / AC) and go back
     to step 1 — a new round. Repeat until approved or paused. Nothing downstream starts meanwhile:
     no exploration / test-case generation while the spec is disapproved, no automation while the
     test cases are.
- **Review later** → leave it `AWAITING_APPROVAL`, stop processing this spec and move on to the
  next. In the report, say exactly what to review and how to continue: `/sdet --approve <ID>`
  (approve as-is) or `/sdet --spec <path>` (re-enter the review, e.g. to request changes).

A run with nobody to answer (scheduled, headless) always takes **Review later** — never approves
on its own.

**5. `--approve <ID>`.** Run `$SDET approval status <ID>`. For each closed gate whose status is
`PENDING`, the user has read what is on disk: `$SDET approval approve <ID> --gate <gate>`. A gate
in `CHANGES_REQUESTED` or never requested can't be approved blind — enter the review loop above
for it instead. Then process the spec as `RESUME`.

**6. Bug gate — one bug at a time, before anything is written to Jira.** Used by §6a after
de-duplication and choosing the link type, so the reviewer sees exactly what would be filed.
1. `$SDET approval check BUG-<NNN> --gate bug`. Already `OPEN` (approved, content unchanged) →
   file it. Previously **declined** → don't ask again and don't file; list it in the report as
   "declined earlier by <who>" (the user can re-open it with `approval request BUG-<NNN> --gate bug`).
2. `$SDET approval request BUG-<NNN> --gate bug`, then show in chat: title, severity / priority,
   the test case and AC it breaks, actual vs. expected in one line each, the evidence paths, and
   what will happen in Jira — "create a new Bug in <project>, **Blocks** PROJ-123 (AC2 cannot be
   met)" or "add an occurrence comment to existing PROJ-456".
3. Ask with `AskUserQuestion`, header `File bug?`:
   - **File to Jira** → `$SDET approval approve BUG-<NNN> --gate bug`, then §6a steps 4–6 (or the reuse comment).
   - **Don't file** → `$SDET approval reject BUG-<NNN> --gate bug --note "<their reason, if they
     gave one>"`. Nothing goes to Jira for it — no issue, no link, no comment. The local bug and
     the test case's result stay as they are. Move straight on to the next bug.
   - **Decide later** → leave it pending, don't file, move on; the report lists it.
4. `jira link-bug` refuses a bug that isn't approved, so a skipped bug can't be recorded as filed.

## 4. Delta workflow (CHANGED)

1. `$SDET specs diff <ID>` — requirement-level delta (items added/removed per section, changed
   fields) plus a line diff against the **last processed** version. For a story spec, a change to
   `jira_updated` / `jira_url` alone is bookkeeping, not a requirement change, and a changed Open
   Question changes no test case by itself — only Acceptance Criteria, Scenarios, Business Rules,
   Roles, Entry Point and Test Data drive the delta.
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
   what changed, add a `release_history` row. Validate and render as in §3.3. Then the human
   review (§3a, gate `test-cases`) — the reviewer sees only the new / updated / obsoleted cases.
5. Automate only `Not Automated` / `Needs Update` cases; ask test-writer to **remove** the automated
   tests of obsoleted cases (found by tag) — `$SDET trace <ID>` warns while any remain. Then §3.5's
   trace/`set-status` steps.
6. Execute only the affected cases: `$SDET run-args --tc <new + updated TC ids>`, then §3.6–3.9.

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

## 6a. Filing genuine defects to Jira (`jira.enabled`)

Only a failure classified `APPLICATION_DEFECT` (or a confirmed `VISUAL_REGRESSION`) goes to Jira —
never an automation, locator, timing, environment, test-data or unknown failure, and never a spec
vs. application question that is really an Open Question. **bug-reporter** always files the local
`BUG-<NNN>.md` first (it has no Jira access); you then mirror it to Jira — **one bug at a time,
and only after the user approves that bug** (step 3). A bug the user declines is not filed; go on
with the next one.

1. **De-duplicate — never file the same defect twice.** (This only decides *what* would happen in
   Jira; nothing is written there until step 3 approves it.)
   - `$SDET jira find-bug --tc <TC_ID>` and `--bug BUG-<NNN>`: a Jira bug already recorded for this
     case or this local bug is the same defect.
   - Otherwise search Jira: `searchJiraIssuesUsingJql` with
     `project = <projectKey> AND issuetype = "<bugIssueType>" AND labels = "<first jira.labels>" AND statusCategory != Done AND (labels = "<TC_ID>" OR issue in linkedIssues(<STORY>))`,
     and compare summaries/steps with this defect.
   - If an open Jira bug is the same defect: plan to **reuse it** — once approved (step 3),
     `addCommentToJiraIssue` with the new occurrence (date, test case, one-line actual result, spec
     version), and record it with
     `$SDET jira link-bug <BUG-KEY> --story <STORY> --tc <TC_ID> --bug BUG-<NNN> --reused`.
     If it is a Jira bug in a Done status that reproduces again, file a new bug (step 3) and link
     it to the old one with `Relates`, noting "regression of <old key>" in the description.
2. **Choose the link type** (from `jira.linkTypes`), per bug:
   Start from bug-reporter's `JIRA LINK HINT` line (`blocks-acceptance: yes|no` and its reason),
   and check it against the rules below:
   - **Blocks** — the defect stops the story from being accepted: an acceptance criterion cannot
     be met (the case proving an AC's primary flow fails, or the defect sits in the AC's core
     behaviour), or bug-reporter rated it `Blocker` / `Critical`.
   - **Relates** — everything else: a `Major` / `Minor` defect where the ACs still hold (a
     validation message, an edge case, a cosmetic or secondary-flow problem), or a defect found in
     adjacent functionality outside this story's ACs.
   State the reason in one line in the bug description ("Blocks PROJ-123: AC2 cannot be met").
3. **Human review of this bug** — §3a step 6. Approved → continue with step 4 (or the reuse
   comment from step 1). Declined or deferred → nothing goes to Jira for this bug; skip steps 4–6
   for it and start step 1 for the next bug. (With `review.bugs` off, `jira.autoCreateBugs`
   applies as before: true = file without asking, false = list every bug and confirm once per run.)
4. **Create.** `createJiraIssue` with `cloudId`, `projectKey`,
   `issueTypeName: <jira.bugIssueType>`, `contentFormat: "markdown"`,
   `summary` = the local bug's title, and `additional_fields: {"labels": [<jira.labels>, "<TC_ID>"]}`
   (plus `priority` when the site accepts bug-reporter's priority name — if Jira rejects a field,
   retry without it rather than failing). The description is the local bug's plain-language
   sections — Summary, Business impact, Steps to reproduce, Expected result (quoting the AC),
   Actual result, Why this is a defect, Environment — followed by a **Traceability** block (story
   key, spec id and version, test case id and title, automation test, local bug file path) and a
   short **Technical details** section. Screenshots, traces, videos and HAR files cannot be
   attached through the connector: list their project-relative paths and say so. Never put a
   credential, token, cookie or personal data in Jira (the same scrubbing as bug-reporter §3).
5. **Link to the story.** `createIssueLink` with `type` = the chosen link type:
   - Blocks: `inwardIssue: <BUG-KEY>` (the blocker), `outwardIssue: <STORY-KEY>` (the blocked
     story) — the story then shows "is blocked by <BUG-KEY>".
   - Relates: `inwardIssue: <BUG-KEY>`, `outwardIssue: <STORY-KEY>`.
   If the link fails, the bug still exists — report the failure and retry once; never create a
   second bug.
6. **Record.** `$SDET jira link-bug <BUG-KEY> --story <STORY> --tc <TC_ID>[,<TC_ID>…] --bug BUG-<NNN> --link-type <Blocks|Relates>`
   (writes `jira_key` / `jira_url` into the local bug file and the bug registry), then
   `$SDET results classify <TC_ID> APPLICATION_DEFECT --issue BUG-<NNN> --issue <BUG-KEY> --actual "…"`.
   (A declined bug keeps only its local link: `--issue BUG-<NNN>`.)
7. A bug found while running a spec that did not come from a story (no `source: jira`) is still
   filed to `jira.projectKey`, just without a story link — after the same review.
8. **Story comment** (only when `jira.commentOnStory` is true): after the run, one
   `addCommentToJiraIssue` on the story — test cases (count by type), pass / fail / blocked,
   bugs raised or reused with their link type (never the declined ones), and the Open Questions. One comment per run, never
   one per test.

## 7. Report

**7a. Issue logs.** Before reporting, always run `$SDET issuelog write` (no ids = rebuild the
whole matrix). It regenerates `issue-logs/TRACEABILITY.md` (Story → Spec → Test Case → Automation →
Last Result → Local Bug → Jira Bug → Link → Bug Status), one `issue-logs/<ID>.md` per story/spec
(story, spec versions, test cases, bugs, run history) and `issue-logs/traceability.json`. Never
edit those files by hand. List them in the report.

Print `$SDET report <processed IDs>` (each failure shows its test status, actual result and linked
issues; the rendered test-cases `.md` has the full Execution Results table), then add, in plain words: per spec, what was classified and
what was done (created / updated / unchanged — "no duplication" for an unchanged spec), any spec vs
application contradictions, bugs filed (local id, Jira key and link type — created or reused),
for a story: whether it was NEW / UPDATED / UNCHANGED at intake and its Open Questions, the review
outcome per gate (who approved, how many rounds, what was corrected — from `$SDET approval status`),
bugs the user declined or deferred (not filed to Jira) with their reasons,
anything skipped and why (missing id declined, duplicate id, blocked environment, **review paused**
— with the file to review and the command to continue), and every warning. Disabled dimensions are reported only as `Disabled`, never
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
   cases only if enabled. Validate, render, and run the human review (§3a, gate `test-cases`).
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
