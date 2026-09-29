---
name: sdet-config
description: Create, view, or change the project's central sdet.config.json — spec folders (created if missing) and discovery rules, the Product Catalog and issue-log folders, Jira story integration (site, project, bug type, link types), which automation layers run (functional/UI, API, visual) and which extra coverage is generated (security, accessibility), the API collection, where test cases/generated tests/state live, and execution behaviour.
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
   files with an `id:` field), whether a `product-catalog/` (or similar project-notes folder)
   exists, and whether `package.json` / `playwright.config.*` and an existing `tests/` layout exist —
   so the proposed values fit this project instead of generic ones.
3. Ask (one `AskUserQuestion` call, four questions):
   - **Spec folder.** If you found spec folders, offer them. If you found none, ask *where the
     project keeps (or should keep) its specs*, offering `specs/` (recommended) and `requirements/`;
     the user can type any other path with "Other". The folder does **not** need to exist — the
     script creates it.
   - **Automation layers** (multi-select: Functional (UI), API, Visual; default Functional only).
   - **Extra coverage** (multi-select: security, accessibility; both off by default).
   - **Jira integration** — "Read user stories from Jira and file genuine defects back to it?"
     (Yes / No, default No). With Yes, `/sdet` requires a story key (`/sdet --story PROJ-123`) for
     generation runs, writes the analysed spec into the spec folder, and files bugs linked to the
     story automatically.

   If API is chosen and the project holds a Postman / OpenAPI / Insomnia file, suggest it as
   `api.collection`. Take every other value from the defaults unless the user volunteers one.
4. **Jira set-up** (only when the user chose Yes). Jira is reached through the Atlassian connector
   (tools named `…getAccessibleAtlassianResources`, `…getVisibleJiraProjects`, etc. — e.g.
   `mcp__claude_ai_Atlassian_Rovo__*`; load them with ToolSearch if they are deferred). If no
   Atlassian connector is available, say so plainly, continue with `--jira=false`, and tell the user
   to connect Atlassian and run `/sdet-config init` again (or `config set jira.enabled true` after
   setting the keys below).
   1. `getAccessibleAtlassianResources` → the site(s). One site: use it. Several: ask which. Keep its
      `id` (→ `jira.cloudId`) and `url` (→ `jira.siteUrl`).
   2. `getVisibleJiraProjects` (cloudId, `action: "create"` — the user must be able to create bugs
      there) → ask which project holds the user stories (`AskUserQuestion` offers at most four:
      show the four most likely — names matching the repository/product first — and the user types
      any other key via "Other"; with more than 50 projects pass `searchString`). Keep `key`
      (→ `jira.projectKey`) and `name` (→ `jira.projectName`).
   3. From that project's issue types (returned with the project, else
      `getJiraProjectIssueTypesMetadata`), confirm a bug type exists. It is usually `Bug`; if the
      project names it differently ("Defect"), use that name (→ `jira.bugIssueType`). If it has no
      bug-like type at all, ask which type to file defects as.
   4. `getIssueLinkTypes` → confirm `Relates` and `Blocks` exist (names vary by site, e.g.
      "Relates" vs "Relates to"); record the exact names found (→ `jira.linkTypes`). The pipeline
      chooses between them per bug (see the sdet skill, §6a).
5. Write it with a single call, e.g.
   `$SDET config init --spec-root specs --functional=true --api=true --visual=false --collection postman/orders.json --security=true --accessibility=false --jira=true --jira-project PROJ --set jira.cloudId=<id> --set jira.siteUrl=https://acme.atlassian.net --set "jira.projectName=Acme Web" [--set jira.bugIssueType=Defect] [--set jira.linkTypes=Relates,Blocks] [--example]`
   The script creates everything the configuration points at that does not exist yet, and never
   overwrites anything that does:
   - every spec folder in `spec.roots` (with a short `README.md` explaining the spec format), plus
     `<first spec root>/jira/` when Jira is on (where story specs are written);
   - `product-catalog/PROJECT-CATALOG.md` — the project-level notes every agent reads first
     (environments and URLs, user roles and permissions, test accounts as env var **names**,
     modules, business rules and glossary, test data, integrations, constraints);
   - `issue-logs/README.md` — the traceability logs `/sdet` regenerates on every run.

   `--example` drops an example spec into the first spec folder; offer it only when that folder is
   empty and Jira is off (with Jira on, specs come from stories).
6. `$SDET config validate`, then show `$SDET config show` and list what was created.
7. Tell the user to fill in `product-catalog/PROJECT-CATALOG.md` — the more it says about roles,
   URLs and test accounts, the less the agents have to guess — and that it must never hold a real
   password or token (env var names only; the values live in `.env`).
8. Recommend adding `.sdet/results/` to the project's `.gitignore` (it holds per-run result files),
   and keeping `sdet.config.json`, `.sdet/state.json`, `.sdet/snapshots/`, `.sdet/history/`,
   `.sdet/jira/`, the test-case folder, `product-catalog/` and `issue-logs/` under version control so
   the whole team shares one state.

**`scaffold`** — `$SDET config scaffold` re-creates any configured folder that is missing (spec
roots, Jira spec folder, Product Catalog, issue logs) without touching existing files. `config set`
does this automatically after a change, so pointing `spec.roots` at a new folder creates it.

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
| `paths.productCatalog` | `product-catalog` | Project-level notes (`PROJECT-CATALOG.md` and any other file there): environments/URLs, user roles, test accounts as env var names, modules, business rules. Read by every agent before exploring, writing test cases or filing bugs. |
| `paths.issueLogs` | `issue-logs` | Generated traceability logs: `TRACEABILITY.md` (Story → Spec → Test Case → Automation → Result → Bug), one `<ID>.md` per story/spec, `traceability.json` (with run history). |
| `review.enabled` | `true` | Human-in-the-loop: pause for a person to approve (or correct) generated specs and test cases before anything is automated. `/sdet --review=false` skips it for one run. |
| `review.spec` | `true` | Review the spec written from a Jira story before exploration (hand-written specs never need it). |
| `review.testCases` | `true` | Review generated / changed test cases before automation. |
| `review.bugs` | `true` | Review each bug before it is filed to Jira; a declined bug is never filed. When off, `jira.autoCreateBugs` decides. |
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
| `jira.enabled` | `false` | Story-driven mode: `/sdet --story <KEY>` reads the Jira story, writes its spec, and files genuine defects to Jira linked to the story. Generation runs without `--story` or `--spec` are refused while it is on. |
| `jira.cloudId` / `jira.siteUrl` | `null` | The Atlassian site (from `getAccessibleAtlassianResources`). Required when Jira is on. |
| `jira.projectKey` / `jira.projectName` | `null` | The Jira project holding the stories and receiving the bugs. Required when Jira is on. |
| `jira.specFolder` | `null` | Where story specs are written; `null` = `<first spec root>/jira`. |
| `jira.bugIssueType` | `Bug` | Issue type genuine defects are filed as. |
| `jira.linkTypes` | `Relates, Blocks` | Link types the pipeline may use between a bug and its story; it picks per bug (sdet skill §6a). |
| `jira.labels` | `sdet-agent` | Labels put on every bug the pipeline files (also used to find its earlier bugs). |
| `jira.autoCreateBugs` | `true` | File genuine defects to Jira without asking. `false` = show the list and confirm once per run. |
| `jira.commentOnStory` | `false` | After a run, post one summary comment on the story (test cases, results, bugs). |

This command changes configuration only — it records no execution-log entry.
