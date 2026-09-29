---
bug_id: BUG-<NNN>
title: <what the user sees go wrong, in plain words - e.g. "No error message when signing in with a wrong password">
status: Open              # Open | Fixed | Regressed | Won't Fix | Duplicate
severity: Major           # Blocker | Critical | Major | Minor
priority: <P0-P3>
application_area: <page or feature as users know it - e.g. "Sign in">
related_test_case: <SPEC_ID-TCnn>
test_case_file: <path to the rendered test-cases .md>
related_test: <automation test file> - <test title>
environment: <browser + version> / <environment name and URL> / <build or commit, if known>
first_seen: <YYYY-MM-DD>
last_seen: <YYYY-MM-DD>
fixed_date:
occurrences: 1
found_by: <pipeline/command that found it, e.g. "/sdet (test-runner)">
tags: []
---

<!--
Plain-language sections first: a product owner or business stakeholder must be able to read
everything above "Technical details" and understand what is wrong, why it matters and how to
see it for themselves - without opening the test code. Writing rules: agents/bug-reporter.md §5.
-->

## Summary

<One or two sentences: what goes wrong, for whom, and where - in the words a user would use.>

## Business impact

- **Who is affected:** <which users or roles>
- **What they cannot do:** <the task that is blocked, delayed or done wrongly>
- **How often:** <every time / only when ... / intermittently (n of m attempts)>
- **Workaround:** <what a user can do instead, or "None">
- **Why this severity:** <one line tying the severity to the impact above>

## Where it happens

<Page or feature, environment (e.g. "Staging website, Chrome"), and the account type or data
involved - described, never the actual password or personal data.>

## Before you start

<What must be true before the steps: e.g. "You need a registered customer account.">

## Steps to reproduce

1. <One user action per step, naming things as they appear on screen - "Click **Sign In**".>
2.
3.

## Expected result

<What should happen, from the requirement / test case - quote the requirement where one exists.>

## Actual result

<What actually happened, describing what the user sees - quote on-screen text exactly.>

## Why this is a defect

<The reasoning, in plain words: which requirement or expected behaviour is not met, how we know
it is the product and not the test or the environment (e.g. "the same steps work for another
field", "reproduced 3 times on a fresh session", "the system reported an internal error"), and
how consistently it happens.>

## Linked test case

- [<SPEC_ID-TCnn> - <test case title>](<relative link to the test-cases .md>)

## Technical details (for the development team)

- Failing check: <the assertion that failed, verbatim>
- Screenshot: `<path>`
- Trace: `<path>` (open with `npx playwright show-trace <path>`)
- Video: `<path>` (if available)
- HAR: `<path>` — key request(s): method, URL, status, timing (redacted headers noted)
- API request/response (if applicable): method, URL, status, sanitized body/timing
- Console errors: relevant lines only
- Mobile only: device <model>, Android <x> (API <n>), app <package> <versionName>; page source `<path>`;
  logcat `<path>` (crash excerpt below, redacted); recording `<path>`; Appium log `.sdet/mobile/appium.log`
- UI / API side: <UI only, API only, or a mismatch between them - balanced runs only>
- Root cause hint (hypothesis, not a diagnosis): <...>

## History

- `<YYYY-MM-DD>` — filed as New (occurrence 1).
