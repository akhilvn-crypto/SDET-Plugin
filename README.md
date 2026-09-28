# sdet-pipeline (Claude Code plugin)

A Claude Code plugin that automates the SDET workflow: writing Playwright + TypeScript tests,
running them, and routing failures/results to the right sub agent — bug reports for real
product bugs, code review for automation-code issues.

## What it does

Six sub agents (`test-writer`, `api-test-writer`, `visual-test-writer`, `test-runner`,
`bug-reporter`, `code-reviewer`) work together behind four pipeline commands (plus `/sdet-config`), guarded by hooks
that block secret leaks, block `.env` commits, and enforce an execution-log entry for every run.

| Command | What it does |
|---|---|
| `/runtest [scope]` | Asks who's running the test and their role, then runs the existing Playwright suite (or a file/`@tag` subset) and diagnoses any failures. |
| `/review-automation [path]` | Reviews Playwright + TypeScript automation code quality (defaults to the current git diff). |
| `/sdet [--spec <path>] [--explore] [--list]` | The one automation command. Spec-aware pipeline: discovers specifications (or explores autonomously when there are none), explores the app, generates traceable test cases, creates/updates only the automation that's missing or affected, runs it, routes real bugs to `bug-reporter` and passing code to `code-reviewer`, and keeps Spec → Test Case → Automation → Result state. Which layers it automates (UI, API, visual) comes from `sdet.config.json`. Safe to re-run: unchanged specs produce no duplicates. |
| `/sdet-config [init\|show\|set\|validate]` | Creates/edits the central `sdet.config.json` — spec folders, UI/API/visual automation layers, API collection, security/accessibility toggles, output paths, execution behaviour. |
| `/update-baselines [scope]` | Reviews every failing visual snapshot by reading its expected/actual/diff images, refuses to re-record a genuine regression, and regenerates only the baselines you confirm are intended. |

Claude also auto-invokes the matching skill from plain language (e.g. "automate the login spec") — no
slash command required.

## Install into your Claude ecosystem

From any project, one-time:

```
/plugin marketplace add akhilvn-crypto/SDET-Plugin
/plugin install sdet-pipeline@sdet-pipeline-marketplace
```

To make it load automatically for anyone who opens a given project, commit this to that
project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "sdet-pipeline-marketplace": {
      "source": { "source": "github", "repo": "akhilvn-crypto/SDET-Plugin" }
    }
  },
  "enabledPlugins": { "sdet-pipeline@sdet-pipeline-marketplace": true }
}
```

After editing a file inside an installed copy of this plugin, run `/reload-plugins` instead of
restarting.

## Running the pipeline

```
/sdet-pipeline:sdet
/sdet-pipeline:runtest
/sdet-pipeline:runtest @smoke
/sdet-pipeline:review-automation
/sdet-pipeline:update-baselines tests/dashboard.visual.spec.ts
```

(Commands are namespaced by plugin name once installed; plain-language requests work too.)

## Spec-driven testing (`/sdet`)

```
/sdet-pipeline:sdet-config init                     # one-time: creates sdet.config.json (asks for spec folders, UI/API/visual layers, security, accessibility)
/sdet-pipeline:sdet                                 # discover specs under spec.roots and process them
/sdet-pipeline:sdet --spec client-a/auth/login.md   # one spec (or a folder) — takes precedence over discovery
/sdet-pipeline:sdet --explore                       # no spec: autonomous exploration
/sdet-pipeline:sdet --list                          # specs + automation state
/sdet-pipeline:sdet --accessibility=true            # override the config for one run
/sdet-pipeline:sdet --api=true --collection ./postman/orders.json   # add the API layer, driven from a collection
```

- **Automation layers** are set in `sdet.config.json` under `testing`: `ui` (on by default),
  `api` and `visual`. Turn on any combination: UI + API gives balanced coverage of the same case,
  and adding visual puts pixel baselines on top. `api.collection` points the API layer at a
  Postman / OpenAPI / Insomnia file.

- **Specs** are Markdown (YAML frontmatter), YAML or JSON anywhere under the configured roots, each
  with a stable `id` and a `version` — see `templates/spec.example.yaml` / `spec.example.md`.
  They describe what to test, never selectors. Moving or renaming a spec file is safe; the `id` is
  its identity. A spec without an id is never processed silently — you confirm the id first.
- **Test cases** live in `test-cases/<SPEC_ID>.test-cases.json` (qa-analyst `TestCaseDocument`
  shape, extended with `spec_id`, `security_relevance`, `accessibility_relevance`,
  `automation_status`) with a rendered `.md` beside it. Case ids (`<SPEC_ID>-TC01`) are never
  reused; removed requirements mark cases `Obsolete`, never delete them.
- **Automation** is linked to test cases by Playwright tags (`@<SPEC_ID>`, `@<SPEC_ID>-TC01`,
  plus `@security` / `@accessibility`), not by filenames.
- **Results go back onto the test cases.** After every `/sdet` or `/runtest` run each executed case
  carries an **Execution Status** (Executed / Not Executed), a **Test Status** (Pass / Fail /
  Blocked / Flaky / Not Run — *Blocked* when an environment, test-data or automation problem meant
  the product could not be checked), a plain-language **Actual Result**, and its **Linked Issues** —
  links to the `bugs/BUG-<NNN>.md` files (or tracker URLs) that show each bug's current title and
  status. The rendered test-cases `.md` gets an Execution Results table. A run is not closed while
  any failure lacks a classification, an actual result, or (for a defect) a linked bug.
- **Bug reports are written for business readers.** `bug-reporter` fills `templates/bug.template.md`:
  summary, business impact, plain steps to reproduce, expected vs actual, and *why this is a
  defect* come first in everyday language; the evidence (errors, trace, HAR, API
  request/response) goes in a separate *Technical details* section for developers.
- **State** is in `.sdet/` (`state.json`, spec snapshots for change diffs, test-case history).
  Commit it with the test cases; gitignore `.sdet/results/`.
- **Security and accessibility** coverage is generated, executed and reported only when enabled in
  `sdet.config.json` (accessibility is off by default; a spec asking for it doesn't turn it on).
- Deterministic parts run through `scripts/sdet.js` (zero dependencies) — run it with no arguments
  for its sub-commands.

## Attribution

Runs are attributed to whoever ran them via `git config user.email` matched against
`config/authors.json`. To be recognized, add yourself to the `authorities` array there (`id`,
`name`, `email` matching your `git config user.email`, optional `designation`) and open a PR —
or set an `SDET_RUNNER_ID` env var to an existing `id` instead. Unrecognized runs are honestly
recorded as `"unknown"`. `/runtest` skips all of that lookup for its own run: it asks you for your
name and role right when you invoke it, and that answer is what gets stamped onto `.lastrun.json`.
