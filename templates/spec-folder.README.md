# Specifications

This folder holds the specifications `/sdet` turns into test cases and Playwright automation.

- One spec per file: `.md` (YAML frontmatter + headings), `.yaml`/`.yml` or `.json`.
- Every spec carries a stable `id` (e.g. `CHECKOUT-001`) and a `version`. The id is its identity -
  rename or move the file freely, but never reuse an id. Bump `version` when you change the spec.
- Describe intent, not implementation: what must be true, not selectors or code.
- Sub-folders are fine, at any depth.

When Jira integration is on (`jira.enabled` in `sdet.config.json`), `/sdet --story <KEY>` reads the
user story and writes its analysed spec to the `jira/` sub-folder (`jira/<KEY>.md`). Those files are
regenerated from Jira when the story changes, so edit the story, not the file.

See `/sdet-config show` for the full list of folders the pipeline searches.
