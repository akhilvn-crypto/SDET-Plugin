---
name: mobile-automate
description: Android mobile pipeline with Appium + Java — check dependencies and the connected device, ask for the app package and launch activity, explore the app, generate test cases (human review), automate them (Maven + TestNG + Page Objects), run them, and file bugs for genuine defects.
---

# Mobile automate — Appium + Java (Android)

```
dependencies ─► device ─► app (package + activity) ─► Appium server ─► explore
   ─► test cases ─[REVIEW]─► automate (Appium Java) ─► run ─► diagnose ─► bugs ─[REVIEW → Jira]─► report ─► record run
```

`$MOBILE` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/mobile.js"`, always run from the project root
(on Git Bash set `MSYS_NO_PATHCONV=1` for any command whose argument starts with `/`). Run it with no
arguments to see every sub-command.

Agents: **mobile-test-writer** (explore + write Appium Java), **mobile-test-runner** (execute +
diagnose), **bug-reporter** (file bugs). The Playwright agents are not used here.

## Arguments

| Flag | Meaning |
|---|---|
| `--package <pkg>` / `--activity <act>` | The app under test. Asked for when not given (§3). |
| `--udid <id>` | Which device, when several are connected. |
| `--apk <file>` | Install/refresh this build before testing (`adb install -r`). |
| `--explore` | Re-explore even when a map for this app version exists. |
| `--run-only` | Skip explore / test-case generation / writing: run the existing suite, diagnose, file bugs. |
| `--tc <ids>` | Limit writing and running to these test cases (`SHOP-TC03,SHOP-TC05`). |
| `--story <KEY>` | Jira story these tests belong to — bugs are linked to it (§9). |
| `--review=false` | Skip the human review gates for this run. |

## 1. Dependencies

Run `$MOBILE doctor`. It checks Node 20.19+, JDK 11+ and `JAVA_HOME`, Maven, `ANDROID_HOME` + build-tools,
adb, the Appium server and the UiAutomator2 driver.

- Exit 0 → one line in chat ("All mobile dependencies available") and continue.
- Anything missing → show its table and the fix lines. Split them:
  - **Can install for the user** (ask first, with `AskUserQuestion`, header `Install`, listing the
    exact commands): `npm install -g appium`, `appium driver install uiautomator2`,
    `sdkmanager "platform-tools" "build-tools;34.0.0"` (only when `sdkmanager` exists under
    `$ANDROID_HOME/cmdline-tools/latest/bin`). Run the approved commands, then `doctor` again.
  - **The user must do** (JDK, Maven, Android SDK, `JAVA_HOME` / `ANDROID_HOME` / `PATH`): explain
    exactly what to install and set, then stop — tell them to re-run `/mobile-automate` in a new
    terminal once done (environment variables are only picked up by a new shell).
  Never continue past step 1 while a required dependency is missing.

## 2. Device

`$MOBILE devices --json`.

- **Exactly one** in state `device` → use it; say which (model, Android version, API level).
- **Several** → `AskUserQuestion` (header `Device`), one option per device ("Pixel 7 — Android 14
  (R58M…)"); or use `--udid` / a remembered `udid` from `$MOBILE config show` if it is connected.
- **`unauthorized` / `offline`** → print the fix the script gives, ask the user to do it, re-check.
- **None** → `$MOBILE avds`. If AVDs exist, ask (header `Device`): boot one of them (up to 3 by name)
  or "I'll connect a phone". Booting: start `"$ANDROID_HOME/emulator/emulator" -avd <name>
  -no-snapshot-save` with `run_in_background`, then wait for `adb -s emulator-5554 shell getprop
  sys.boot_completed` to print `1` (poll every ~10 s, give up after 4 minutes and report). No AVDs →
  explain how to connect a phone with USB debugging or create an AVD, and stop.

The screen must be unlocked for the whole run — remind the user once.

## 3. App under test — ask for the package and activity

Collect candidates, in this order: `--package`/`--activity`; the remembered values in
`$MOBILE config show`; and the app currently on screen (`$MOBILE foreground --udid <udid>`, ignoring
launchers and `com.android.*` / `com.google.android.*` system apps).

Ask with `AskUserQuestion` (header `App`) — "Which app should I test?":
- **`<package>` / `<activity>` (remembered)** — when config has them;
- **The app open on the device now — `<package>` / `<activity>`** — when one was detected;
- The user can always choose *Other* and type `package/activity`, or just the package (the launch
  activity is then resolved from the launcher). Tell them the tip: open the app on the device and
  pick the second option, or run `adb shell dumpsys window | findstr mCurrentFocus`.

Skip the question only when both `--package` and `--activity` were given.

Validate: `$MOBILE app --package <pkg> [--activity <act>] --udid <udid>`.
- Exit 3 (not installed) → with `--apk`: `adb -s <udid> install -r "<apk>"` and re-check; otherwise
  ask for the APK path (or to install it themselves) — never test a different app.
- Exit 4 (activity not found) → show `launcherActivity` and ask whether to use it instead.
- No activity given → use `launcherActivity`; if there is none, ask for the activity.
- `--apk` given and already installed → reinstall with `-r` so the run tests that build.

**App id** — the prefix of every test-case id: remembered `appId`, else `$MOBILE appid <pkg>`
(e.g. `com.acme.shop` → `SHOP`). Mention it in chat; the user can override it with *Other* in the
question above (e.g. "com.acme.shop/.MainActivity as ACME").

Remember everything: `$MOBILE config set appPackage=<pkg> appActivity=<full activity> udid=<udid> appId=<ID>`
(`udid=` blank when only one device is ever used). Note `versionName` for the report.

## 4. Appium server

`$MOBILE server status`. Not running → start it with `run_in_background`:
`appium --address 127.0.0.1 --port 4723 --log .sdet/mobile/appium.log --log-no-colors`
(create `.sdet/mobile/` first), then poll `server status` every few seconds (≤ 60 s). If port 4723
is taken by something that isn't Appium, use 4724 and `$MOBILE config set appiumUrl=http://127.0.0.1:4724`.
Leave a server you started running until the end of the run, then stop it (§11). Never stop a
server the user already had running.

`--run-only` → jump to §8.

## 5. Explore

Skip when `automation-knowledge/exploration/mobile/<APP_ID>.md` exists and its header shows the same
app `versionName`, unless `--explore` — then only note "exploration map reused".

Otherwise hand **mobile-test-writer** mode `EXPLORE` with `APP_ID`, package, activity, udid, Appium
URL and the product-catalog path. Tell it which area to focus on if the user named one.

From its output keep: the screens and flows, the proposed scenarios, the anomalies, what it could
not explore (e.g. behind a login with no test account). An anomaly is *not* a bug yet — it becomes
a test case, and only a failing test with evidence becomes a bug.

## 6. Test cases

File: `test-cases/mobile/<APP_ID>.test-cases.json` (`$MOBILE testcases path <APP_ID>`), rendered
to `.md` beside it. Shape:

```json
{
  "meta": {
    "app_id": "SHOP", "app_name": "Acme Shop", "package": "com.acme.shop",
    "activity": "com.acme.shop.MainActivity", "app_version": "3.4.1", "platform": "android",
    "version": 1, "generated_on": "YYYY-MM-DD", "source": "exploration",
    "not_covered": ["Checkout payment - would place a real order"],
    "changelog": [{ "version": 1, "date": "YYYY-MM-DD", "note": "Initial test cases from exploration" }]
  },
  "test_cases": [{
    "id": "SHOP-TC01", "title": "Sign in with a registered account", "screen": "Sign in",
    "flow": "Sign in", "type": "Functional", "priority": "High", "tags": ["smoke"],
    "preconditions": ["App freshly launched", "A registered customer account (TEST_USER_EMAIL / TEST_USER_PASSWORD)"],
    "test_data": "Registered customer account from env vars",
    "steps": [
      { "step": 1, "action": "Tap **Sign in** on the welcome screen", "expected": "The sign-in form opens" },
      { "step": 2, "action": "Enter the email and password, tap **Continue**", "expected": "The Home screen shows 'Hi, <first name>'" }
    ],
    "expected_result": "The user lands on Home, signed in.",
    "automation_status": "Not Automated"
  }]
}
```

Rules:
- Cover each explored flow: the happy path, validation / negative cases with the **exact messages
  observed**, edge cases (long input, special characters, empty lists), navigation (back button,
  returning to the app, relaunch keeps/clears state as expected), and — where the flow warrants it —
  rotation, keyboard covering fields, permission prompts, no-network handling (only if it can be
  simulated safely). Types: `Functional`, `Negative`, `Edge`, `Navigation`, `UI`, `Regression`.
- Steps name things as they appear on screen, never locators. Test data by role and env-var name,
  never a credential value.
- Priorities: High = core business flow / smoke; Medium = validation and secondary flows; Low = cosmetic.
- **Stable ids.** When the file already exists: keep every existing id; add new cases after the
  highest number; a case whose screen/flow no longer exists becomes `"automation_status": "Obsolete"`
  (never delete a committed case); bump `meta.version` and add a changelog line only when content
  changed.
- Cases that must not be automated (real payments, OTP to a real phone, two devices) are still
  written, with `"automation_status": "Not Automatable"` and a `"notes"` reason.

`$MOBILE testcases render <APP_ID>` (validates, then writes the `.md`). Fix any `ERROR` it prints.

### 6a. Human review gate

Unless `--review=false` or `review.enabled` / `review.testCases` is false in `sdet.config.json`:
present briefly in chat — the `.md` path, a table `TC ID | Title | Screen | Type | Priority`
(on a re-review only the new/changed cases plus a count of the unchanged), `not_covered`, and any
assumption to confirm (which account, which environment). Then `AskUserQuestion`, header `Review`:

- **Approve** — "Automate these as they are." → `$MOBILE testcases approve <APP_ID> --by "<name>"`
  (name from `config/authors.json` via git email, else ask once).
- **Disapprove** — "Something needs to change." → ask what is wrong and what it should say (wait for
  the answer; ask a follow-up if it is too vague to act on — never guess), then
  `$MOBILE testcases reject <APP_ID> --note "<their words>"`, fix the JSON (ids stay stable),
  render, show a short before → after, and ask again. Loop until approved or paused.
- **Review later** — stop here. Report the file to review and how to continue:
  `/mobile-automate` again (it resumes at this gate: `$MOBILE testcases status <APP_ID>`).

A run with nobody to answer always takes *Review later*. Nothing is automated before approval.
Approved content that is unchanged since the last approval needs no new review.

## 7. Automate

Hand **mobile-test-writer** mode `WRITE` with `APP_ID`, package, activity, udid, Appium URL, and the
approved cases to automate: those with `automation_status` `Not Automated` (or with changed content),
limited by `--tc`. It scaffolds `mobile-tests/` from the plugin template on first run, writes screen
objects and TestNG tests (each tagged `<APP_ID>` + `<APP_ID>-TCnn` in `groups` and `description`),
compiles, runs each new test, and fixes automation problems (never assertions) up to 3 times.

Then update the JSON from its output: `"automation_status": "Automated"` and `"automation_ref":
"<Class#method>"` for each written case; `"Not Automatable"` + `notes` for any it could not
automate. Render again.

## 8. Run and diagnose

Hand **mobile-test-runner** the scope: `-Dgroups=<APP_ID>` (whole app), or the `--tc` ids, plus the
udid. Then:

1. `$MOBILE results ingest <APP_ID>` — writes execution status, test status and (for passes) the
   actual result onto each case.
2. For every failed case: `$MOBILE results classify <APP_ID> <TC_ID> <CATEGORY> --actual "<runner's
   ACTUAL RESULT line>"` — plain words, never the raw exception.
3. Automation-side failures (`LOCATOR_FAILURE`, `TIMING_FAILURE`, `TEST_DATA_FAILURE`) on tests
   written this run → back to **mobile-test-writer** once to fix, then re-run just those cases.
   `ENVIRONMENT_FAILURE` / `DEVICE_FAILURE` → fix the device/server if it's obvious (reconnect, unlock,
   restart Appium) and re-run once; otherwise report them as Blocked. `ASSERTION_FAILURE` → list for a
   human decision; not a bug.

## 9. Bugs

For each `APPLICATION_DEFECT` or `APP_CRASH`, hand **bug-reporter**: the test case (from the JSON),
the runner's diagnosis, and the evidence dir `mobile-tests/target/evidence/<Class.method>/`
(screenshot, page source, logcat, recording) plus `.sdet/mobile/appium.log`, and the device / app
version. It files or bumps `bugs/BUG-<NNN>.md` (mobile evidence per its §2) and returns a
`TEST CASE UPDATE` line → record it:
`$MOBILE results classify <APP_ID> <TC_ID> <CATEGORY> --issue BUG-<NNN> --actual "..."`.

**Jira** (only when `sdet.config.json` has `jira.enabled: true`), one bug at a time:
1. De-duplicate: `searchJiraIssuesUsingJql` —
   `project = <projectKey> AND issuetype = "<bugIssueType>" AND labels = "<first jira.labels>" AND labels = "<TC_ID>" AND statusCategory != Done`
   — and a local bug file already carrying `jira_key`. Same defect open in Jira → plan an occurrence
   comment instead of a new issue.
2. Unless reviews are off, show the bug (title, severity, TC, expected vs actual, evidence paths,
   and what will happen in Jira) and ask, header `File bug?`: **File to Jira** / **Don't file** /
   **Decide later**. Only *File to Jira* writes anything to Jira.
3. Create with `createJiraIssue` (summary = bug title; description = the bug's plain-language
   sections + a Traceability block: app id, package, app version, TC id and title, automation test,
   local bug path + a short Technical details section; labels = `jira.labels` + `<TC_ID>` + `mobile`).
   Evidence files can't be attached through the connector — list their paths. With `--story`, link
   with `createIssueLink` (`Blocks` when a core flow is broken or severity is Blocker/Critical,
   else `Relates`; bug = inward, story = outward).
4. Write `jira_key:` / `jira_url:` into the bug file's frontmatter, and
   `$MOBILE results classify <APP_ID> <TC_ID> <CATEGORY> --issue BUG-<NNN> --issue <JIRA-KEY> --actual "..."`.

Never put a credential, token or personal data in a bug or in Jira.

## 10. Close the run

`$MOBILE results pending <APP_ID>` must print `OK` (every failure classified, has an actual result,
and every defect links a bug). Fix what it lists before reporting.

Report in plain words:
- environment: device (model, Android, API), app package / version, Appium + UiAutomator2 versions;
- exploration: reused or new, screens/flows found, what wasn't explored and why;
- test cases: new / changed / unchanged / obsolete, review outcome (who, rounds, corrections);
- automation: files created/modified under `mobile-tests/`, cases not automatable and why;
- results: pass / fail / blocked / flaky, each failure with its category and actual result;
- bugs: new / still open / fixed / regressed (local id, Jira key if filed; declined ones and why);
- how to re-run: `cd mobile-tests && mvn test -Dgroups=<APP_ID>` (or `-Dgroups=smoke`).

## 11. Record the run

Stop an Appium server you started (the background task). Then set `MSYS_NO_PATHCONV=1` and run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" --pipeline mobile-automate --command "<exactly how this was invoked, e.g. '/mobile-automate --package com.acme.shop'>" --agents <agents actually used, comma-separated> --status <pass|fail|blocked> --summary "<app id + version; n test cases (new/changed); tests p/f/b; bugs>" --specs <APP_ID>`,
adding `--bugs-new/--bugs-still-open/--bugs-fixed/--bugs-regressed` from bug-reporter's output. Let it
auto-detect changed files from git. A run that stopped at step 1–4 (missing dependency, no device,
wrong app) or at *Review later* still records, with `--status blocked` and the reason in `--summary`.
