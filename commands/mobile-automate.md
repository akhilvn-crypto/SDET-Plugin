---
description: Android mobile pipeline (Appium + Java) — check dependencies and the connected device, ask for the app's package and launch activity, explore the app, generate test cases (human review), automate them in Appium Java, run them, and file bugs for genuine defects.
argument-hint: "[--package <pkg>] [--activity <act>] [--udid <device>] [--apk <file.apk>] [--explore] [--run-only] [--tc <TC ids>] [--story <JIRA-KEY>] [--review=true|false]"
---

Invoke the **mobile-automate** skill (`skills/mobile-automate/SKILL.md`) with these arguments: ${ARGUMENTS:-(none — check the environment, then ask for the app's package and activity)}
