# sdet-pipeline (Claude Code plugin)

A portable packaging of the SDET automation pipeline — five sub agents, four pipeline
skills/commands, and three guardrail hooks — as a Claude Code **plugin**, so it can be installed
into any project instead of living only in this workspace's `.claude/`.

This folder is a straight repackaging of what already works in [`../.claude/`](../.claude/README.md)
(kept as-is for local work in *this* workspace) — same agents, same pipeline logic, same rules.
Only the handful of things that had to change to make it install-anywhere (bundled-script paths,
the execution-log script's working-directory assumption) were touched; see "What changed" below.

## What's inside

| Directory | Contents |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (name, version, description). |
| `agents/` | The same 5 sub agents: `test-writer`, `api-test-writer`, `test-runner`, `bug-reporter`, `code-reviewer`. |
| `commands/` | The same 4 slash commands: `/automate`, `/automate-api`, `/regression`, `/review-automation` (installed, these appear as `/sdet-pipeline:automate` etc. — see "Invoking" below). |
| `skills/` | The same 4 pipeline skills, one `SKILL.md` per pipeline — the actual instructions `commands/` forwards to. |
| `hooks/hooks.json` + `hooks/*.js` | The same 3 guardrail hooks (secret-leak blocking on Write/Edit, `.env`-commit blocking on Bash, execution-log enforcement on Stop), wired via `${CLAUDE_PLUGIN_ROOT}` instead of `$CLAUDE_PROJECT_DIR/.claude`. |
| `scripts/record-run.js` | The execution-log writer, invoked as the last step of every pipeline run. |
| `config/authors.json` | Team runner-authority registry (used by `record-run.js` to attribute each run) — see "Onboarding a new teammate" below. Overridable per project. |
| `.claude-plugin/marketplace.json` | Lets this same folder be added as a marketplace, so teammates can `/plugin install` it instead of every machine needing its own `--plugin-dir` flag. |

`automation-knowledge/` and `bugs/` are **not** part of this plugin — they're per-project runtime
data (exploration knowledge, failure lessons, live bug list) that each agent creates/updates inside
whatever project it's automating, exactly as documented in `.claude/README.md`. A fresh project
gets a fresh `automation-knowledge/`/`bugs/` the first time an agent needs one.

## Sharing this with the team

This folder is self-contained and git-shareable as-is — it already carries its own
`.claude-plugin/marketplace.json` (pointing at itself via `"source": "."`), so once it's pushed
somewhere your teammates can reach, no one needs to hand-edit a `--plugin-dir` flag on every
machine:

1. **Push this `SDET plugin/` folder to a shared git repo** (its own repo, e.g.
   `your-org/sdet-pipeline-plugin`, is the cleanest option — keeps it decoupled from any one
   project's own repo, matching how it's decoupled from this workspace's `.claude/` right now).
2. Each teammate runs, once:
   ```
   /plugin marketplace add your-org/sdet-pipeline-plugin
   /plugin install sdet-pipeline@sdet-pipeline-marketplace
   ```
   (or a full URL instead of `owner/repo` if it's hosted somewhere other than GitHub — see
   Claude Code's plugin-marketplace docs for the `source` shapes it accepts).
3. **Optional — auto-register it for anyone who opens the project**, instead of everyone running
   step 2 by hand: commit an `extraKnownMarketplaces`/`enabledPlugins` block to the *project's*
   `.claude/settings.json` (not this plugin folder):
   ```json
   {
     "extraKnownMarketplaces": {
       "sdet-pipeline-marketplace": {
         "source": { "source": "github", "repo": "your-org/sdet-pipeline-plugin" }
       }
     },
     "enabledPlugins": { "sdet-pipeline@sdet-pipeline-marketplace": true }
   }
   ```
   Claude Code picks this up the moment a teammate trusts that project folder.

**Local/dev use without a shared repo yet** — point directly at a shared folder or a personal
clone:
```
claude --plugin-dir "\\shared\drive\path\SDET plugin"
```
Reload after editing a file inside this plugin with `/reload-plugins` instead of restarting.

## Onboarding a new teammate

`config/authors.json` is what makes `.lastrun.json` say *who* ran a pipeline, automatically, with
no per-run flag. It ships with no hardcoded default person — an unrecognized teammate's run is
honestly recorded as `"unknown"` rather than silently attributed to whoever set the plugin up.

To get proper attribution: add yourself to the `authorities` array in `config/authors.json` — an
`id` (kebab-case, unique), `name`, `email` (must exactly match `git config user.email` on your
machine, since that's how a run gets matched to you automatically), and optionally a
`designation`. Open a PR against the shared plugin repo (or edit your own clone if you're not
sharing changes back). Alternatively, set an `SDET_RUNNER_ID` env var to an existing `id` if you'd
rather not have your email in the shared file, or drop a project-specific `.claude/config/
authors.json` into one particular project to override the plugin's bundled registry there only.

## Invoking

Once installed, the commands are namespaced by plugin name: `/sdet-pipeline:automate`,
`/sdet-pipeline:automate-api`, `/sdet-pipeline:regression`, `/sdet-pipeline:review-automation`.
Claude also auto-invokes the matching skill from a plain-language request (e.g. "automate TC-102")
the same way it does in the project-level setup — no slash command required.

## What changed vs. the project-level `.claude/` version

Packaging this as an installable plugin (rather than a folder embedded in one project) meant the
bundled script's own directory no longer matches the target project's root, so a few things had to
become path-aware instead of hardcoded:

1. **`hooks/hooks.json`** — new file (plugins configure hooks here, not in `settings.json`). Each
   hook command uses `${CLAUDE_PLUGIN_ROOT}` (Claude Code's plugin-install-path variable) instead
   of `$CLAUDE_PROJECT_DIR/.claude`.
2. **`scripts/record-run.js`** — no longer resolves its output path (`.lastrun.json`) or config
   fallback relative to its own `__dirname` (which would point at the plugin's install directory,
   e.g. under `~/.claude/plugins/...`, not the project being automated). It now resolves
   `.lastrun.json` against `process.cwd()` — the target project's root, which is where every
   pipeline skill already runs commands from — and additionally checks the target project's own
   `.claude/config/authors.json` before falling back to this plugin's bundled `config/authors.json`.
3. **The 4 `skills/*/SKILL.md` files** — the "record the run" step now invokes
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js"` instead of a literal
   `.claude/scripts/record-run.js` path that only existed in the original project layout.
4. **`hooks/enforce-run-log.js`** — its pipeline-command regex now also matches a
   plugin-namespaced command (`/sdet-pipeline:automate`) in addition to the plain `/automate` form,
   and its block message resolves the exact bundled script path from `CLAUDE_PLUGIN_ROOT` at
   runtime instead of hardcoding `.claude/...`.
5. **A few doc-only cross-references** inside `agents/*.md` (e.g. "see `.claude/commands/
   automate.md`") were updated to the plugin-relative path (`commands/automate.md`).
6. **`config/authors.json`** — dropped the two fields that were specific to this workspace's
   current engagement (`projectName`, `projectId`). More importantly, since this plugin is shared
   across a team rather than embedded in one person's project, it no longer has a single hardcoded
   `default` identity — that would have silently attributed every teammate's run to whoever set
   the plugin up. An unmatched run now records as `"unknown"` instead; see "Onboarding a new
   teammate" above for how each person gets attributed correctly (via `git config user.email`).

Everything else — the pipeline logic, the stack rule, the balanced-by-default behavior, the
`automation-knowledge/`/`bugs/` conventions, the soft/hard-assertion guidance, the security rules —
is unchanged from `.claude/README.md`. That file remains the fuller narrative doc; this one covers
only the plugin-specific packaging delta.
