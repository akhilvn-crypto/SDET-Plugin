---
description: Spec-aware pipeline — read a Jira story into a spec (Jira mode) or discover specs (or explore autonomously), explore the app, generate traceable test cases, create/update only the UI/API/visual automation (per config) that's missing or affected, execute, persist state, report Spec -> Test Case -> Automation -> Result.
argument-hint: "[--story <JIRA-KEY>]... [--spec <file or folder>]... [--explore [area]] [--list] [--report [ID...]] [--dry-run] [--functional=true|false] [--api=true|false] [--visual=true|false] [--collection <file>] [--security=true|false] [--accessibility=true|false] [--set key=value] [--excel]"
---

Invoke the **sdet** skill (`skills/sdet/SKILL.md`) with these arguments: ${ARGUMENTS:-(none — discover specs from the configured roots, or explore autonomously if there are none)}
