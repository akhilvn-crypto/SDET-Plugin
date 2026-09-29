# Project Catalog

<!--
Project-level knowledge the SDET agents read BEFORE exploring the application, writing test cases
or filing bugs. Fill in what you know and leave the rest - an empty row is fine, a guessed one is not.

  NEVER put a real password, token, API key or personal data in this file.
  Test accounts are referenced by the NAME of the environment variable that holds the value
  (e.g. ADMIN_PASSWORD), and the value lives in your .env file, which is never committed.

You can add more files to this folder (API notes, domain glossaries, exported role matrices, etc.) -
every file in product-catalog/ is read.
-->

## Application overview

- **Product name:**
- **What it does (one or two sentences):**
- **Primary users:**
- **Tech notes relevant to testing** (SPA, SSO, feature flags, multi-tenant, ...):

## Environments & URLs

| Environment | Base URL | API base URL | Notes |
|---|---|---|---|
| QA / Staging |  |  |  |
| UAT |  |  |  |
| Production (read-only, never tested destructively) |  |  |  |

**Default environment for automation:**

## User roles & permissions

| Role | What this role can do | What this role must NOT be able to do |
|---|---|---|
| Admin |  |  |
| Standard user |  |  |
| Guest / anonymous |  |  |

## Test accounts

<!-- Env var NAMES only - never the values. -->

| Role | Username env var | Password env var | Notes (MFA, locked data, tenant...) |
|---|---|---|---|
| Admin | `ADMIN_USERNAME` | `ADMIN_PASSWORD` |  |
| Standard user | `USER_USERNAME` | `USER_PASSWORD` |  |

## Modules / features

| Module | Entry URL or menu path | Owner / team | Notes |
|---|---|---|---|
|  |  |  |  |

## Business rules & glossary

<!-- Rules that apply across stories (rounding, currency, date formats, limits, statuses), and
     domain terms the stories use. The agents use these to resolve ambiguity instead of guessing. -->

- 

## Test data

<!-- Seed data, reusable records, data that must not be modified, cleanup rules. -->

- 

## Integrations & third parties

<!-- Payment gateways (sandbox?), email/SMS (where do test emails land?), SSO providers, etc. -->

- 

## Known constraints

<!-- Rate limits, maintenance windows, captcha, areas that must not be automated, flaky environments. -->

- 
