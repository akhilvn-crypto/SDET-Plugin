# sdet-pipeline (Claude Code plugin)

A Claude Code plugin that automates the SDET workflow: writing Playwright + TypeScript tests,
running them, and routing failures/results to the right sub agent — bug reports for real
product bugs, code review for automation-code issues.

## What it does

Five sub agents (`test-writer`, `api-test-writer`, `test-runner`, `bug-reporter`,
`code-reviewer`) work together behind four pipeline commands, guarded by hooks that block
secret leaks, block `.env` commits, and enforce an execution-log entry for every run.

| Command | What it does |
|---|---|
| `/automate <test case>` | Full pipeline for one approved test case — writes the test (UI by default, API-only or balanced when asked), runs it, then routes to `bug-reporter` (real bug) or `code-reviewer` (bad test code). |
| `/automate-api <test case>` | Same pipeline, API-only — can be driven from a Postman/OpenAPI/Insomnia collection with `--collection <path>`. |
| `/runtest [scope]` | Asks who's running the test and their role, then runs the existing Playwright suite (or a file/`@tag` subset) and diagnoses any failures. |
| `/review-automation [path]` | Reviews Playwright + TypeScript automation code quality (defaults to the current git diff). |

Claude also auto-invokes the matching skill from plain language (e.g. "automate TC-102") — no
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
/sdet-pipeline:automate TC-102
/sdet-pipeline:automate-api TC-201 --collection ./postman/orders.json
/sdet-pipeline:runtest
/sdet-pipeline:runtest @smoke
/sdet-pipeline:review-automation
```

(Commands are namespaced by plugin name once installed; plain-language requests work too.)

## Attribution

Runs are attributed to whoever ran them via `git config user.email` matched against
`config/authors.json`. To be recognized, add yourself to the `authorities` array there (`id`,
`name`, `email` matching your `git config user.email`, optional `designation`) and open a PR —
or set an `SDET_RUNNER_ID` env var to an existing `id` instead. Unrecognized runs are honestly
recorded as `"unknown"`. `/runtest` skips all of that lookup for its own run: it asks you for your
name and role right when you invoke it, and that answer is what gets stamped onto `.lastrun.json`.
