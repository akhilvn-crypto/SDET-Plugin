---
name: sdet-config
description: Create, view, or change the project's central sdet.config.json — spec folders and discovery rules, which automation layers run (functional/UI, API, visual) and which extra coverage is generated (security, accessibility), the API collection, where test cases/generated tests/state live, and execution behaviour.
---

# SDET config

One file, `sdet.config.json` at the project root, controls the spec-aware pipeline (`/sdet`).
Every key falls back to the plugin default when absent, and `/sdet` runtime flags
(`--api=true`, `--accessibility=true`, `--spec <path>`, `--set key=value`) override it for a single run:
**runtime flag > sdet.config.json > plugin default**.

All reads and writes go through the script — never hand-assemble the JSON:

```
SDET='node "${CLAUDE_PLUGIN_ROOT}/scripts/sdet.js"'
```

## Sub-commands (first argument)

**`init`** (default when no `sdet.config.json` exists yet) — interactive set-up:

1. If the file already exists, show `$SDET config show` and ask whether to keep it (stop), change
   individual values (go to `set`), or recreate it from defaults (`--force`). Never overwrite it
   without that explicit choice.
2. Look before asking: list likely spec folders in the project (`specs/`, `requirements/`,
   `test-specs/`, `specifications/`, `docs/specs/` or any folder holding `.md`/`.yaml`/`.yml`/`.json`
   files with an `id:` field) and whether `package.json` / `playwright.config.*` and an existing
   `tests/` layout exist — so the proposed values fit this project instead of generic ones.
3. Ask (one `AskUserQuestion` call, four questions): spec folder(s), offering what you found;
   which automation layers to run (multi-select: Functional (UI), API, Visual, default Functional only); which extra
   coverage to include (multi-select: security, accessibility, both off by default); and whether to
   add an example spec. If API is chosen and the project holds a Postman / OpenAPI / Insomnia file,
   suggest it as `api.collection`. Take every other value from the defaults unless the user
   volunteers one.
4. Write it with a single call, e.g.
   `$SDET config init --spec-root specs,requirements --functional=true --api=true --visual=false --collection postman/orders.json --security=true --accessibility=false [--example] [--set paths.generatedTests=tests/e2e/generated]`
   (`--example` also drops an example spec into the first spec folder).
5. `$SDET config validate`, then show `$SDET config show`.
6. Recommend adding `.sdet/results/` to the project's `.gitignore` (it holds per-run result files),
   and keeping `sdet.config.json`, `.sdet/state.json`, `.sdet/snapshots/`, `.sdet/history/` and the
   test-case folder under version control so the whole team shares one state.

**`show`** — `$SDET config show` (add any overrides the user passed to preview their effect).

**`set <key> <value>`** — `$SDET config set <key> <value>`, e.g. `config set spec.roots specs,docs/specs`
or `config set testing.accessibility true`. Unknown keys are refused. Then `$SDET config validate`.

**`validate`** — `$SDET config validate` and explain any error in plain words.

## Settings reference

| Key | Default | Meaning |
|---|---|---|
| `spec.enabled` | `true` | Discover specs automatically. `false` = only explicit `--spec` paths, else autonomous mode. |
| `spec.roots` | `["specs"]` | Folders searched for specs (project-relative). Any structure, any depth. `spec.root: "x"` is accepted as a single-folder alias. |
| `spec.recursive` | `true` | Search sub-folders. |
| `spec.extensions` | `.md .yaml .yml .json` | File types treated as specs. |
| `spec.exclude` | `node_modules`, `.git`, `.sdet`, `test-results`, `playwright-report`, `README.md` | Names or project-relative paths skipped during discovery. |
| `spec.idPattern` | `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$` | Shape a stable spec id must have (e.g. `MAGENTO-LOGIN-001`). |
| `testing.functional` | `true` | Automation layer: functional UI testing — `test-writer` automates each case through the browser with Playwright. (Replaces the old `testing.ui`, which is still read and migrated.) |
| `testing.api` | `false` | Automation layer: `api-test-writer` automates the API half of each case, plus `API`-type cases. |
| `testing.visual` | `false` | Automation layer: `visual-test-writer` adds full-page and component visual baselines. |
| `testing.security` | `false` | Non-destructive security cases and automation. |
| `testing.accessibility` | `false` | Accessibility cases, axe scans, and accessibility findings. Off unless set to `true`. |
| `api.collection` | `null` | Postman / OpenAPI / Insomnia file (project-relative) that drives the API layer. `null` = the API layer explores the endpoints itself. |
| `paths.testCases` | `test-cases` | Where `<SPEC_ID>.test-cases.json` / `.md` live. |
| `paths.generatedTests` | `tests/generated` | Default home for new spec files when the project has no convention of its own. |
| `paths.stateDir` | `.sdet` | Lifecycle state, spec snapshots, test-case history, run results. |
| `paths.bugs` | `bugs` | Where `bug-reporter` files `BUG-<NNN>.md`; test cases link to bugs here (`results classify --issue BUG-004`). |
| `execution.runAfterGenerate` | `true` | Execute affected tests after creating/updating automation. |
| `execution.onUnchanged` | `verify` | For an unchanged spec: `skip` (report only), `verify` (check automation still maps to every case), `run` (also execute). |
| `execution.playwrightProject` | `null` | Limit runs to one Playwright project (e.g. `chromium`). |
| `accessibility.engine` | `@axe-core/playwright` | Scanner used when accessibility is enabled (existing tooling in the project is reused first). |
| `accessibility.wcagTags` | `wcag2a, wcag2aa, wcag21a, wcag21aa` | axe rule tags to run. |
| `accessibility.failOnImpact` | `critical, serious` | Violation impacts that fail an accessibility test. |
| `security.nonDestructiveOnly` | `true` | Security checks never alter data or stress the system. |
| `security.authorizedHosts` | `[]` | Hosts security checks may touch; empty = the application's configured base URL only. |
| `autonomous.idPrefix` | `AUTO` | Prefix for areas discovered without a spec (`AUTO-CHECKOUT`). |
| `autonomous.maxAreas` | `3` | Workflows automated per autonomous run. |

This command changes configuration only — it records no execution-log entry.
