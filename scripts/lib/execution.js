/**
 * What a test case's last run means, in the terms a test report uses: execution status,
 * test status, actual result and linked issues. Shared by results.js (which records a run)
 * and testcases.js (which renders it), so the two never disagree.
 *
 *   execution_status  Executed | Not Executed                 - did the test actually run
 *   test_status       Pass | Fail | Blocked | Flaky | Not Run - what the run says about the product
 *   actual_result     plain-language outcome; written by the pipeline for failures (never the raw error)
 *   linked_issues     on the test case itself, so a bug link outlives the run that found it
 */
const fs = require('fs');
const path = require('path');
const { rel, today, UsageError } = require('./util');
const { parseYamlLite } = require('./yaml-lite');

// The existing automation-knowledge/failures taxonomy (fine-grained) rolled up into
// the reporting buckets the lifecycle report uses.
const CLASSIFICATION_BUCKETS = {
  APPLICATION_DEFECT: 'Application Defect',
  VISUAL_REGRESSION: 'Application Defect',
  ASSERTION_FAILURE: 'Test Defect',
  FRAMEWORK_FAILURE: 'Test Defect',
  CONFIGURATION_FAILURE: 'Test Defect',
  LOCATOR_FAILURE: 'Automation/Locator Issue',
  TIMING_FAILURE: 'Automation/Locator Issue',
  AUTHENTICATION_FAILURE: 'Environment Issue',
  ENVIRONMENT_FAILURE: 'Environment Issue',
  NETWORK_FAILURE: 'Environment Issue',
  TEST_DATA_FAILURE: 'Test Data Issue',
  UNKNOWN: 'Unknown',
};

// A failure in one of these buckets says nothing about the product - the case could not be
// verified, so it is Blocked rather than Fail. Unclassified and Unknown stay Fail until diagnosed.
const BLOCKING_BUCKETS = new Set(['Test Defect', 'Automation/Locator Issue', 'Environment Issue', 'Test Data Issue']);
const DEFECT_CATEGORIES = new Set(['APPLICATION_DEFECT', 'VISUAL_REGRESSION']);

const TEST_STATUSES = ['Pass', 'Fail', 'Blocked', 'Flaky', 'Not Run'];
const EXECUTION_STATUSES = ['Executed', 'Not Executed'];

const PASSED_RESULT = 'As expected - every step produced its expected result.';
const SKIPPED_RESULT = 'Not run - the test was skipped in this execution.';

function executionStatusOf(e) {
  return e && e.status !== 'Skipped' ? 'Executed' : 'Not Executed';
}

function testStatusOf(e) {
  if (!e || e.status === 'Skipped') return 'Not Run';
  if (e.status === 'Passed') return 'Pass';
  if (e.status === 'Flaky') return 'Flaky';
  return BLOCKING_BUCKETS.has(CLASSIFICATION_BUCKETS[e.classification]) ? 'Blocked' : 'Fail';
}

function defaultActualResult(e) {
  if (e.status === 'Passed') return PASSED_RESULT;
  if (e.status === 'Skipped') return SKIPPED_RESULT;
  if (e.status === 'Flaky') return `Passed only after ${e.retries} retr${e.retries === 1 ? 'y' : 'ies'} - the first attempt failed, so the result is inconsistent and needs a closer look.`;
  return null; // a failure's actual result is written from the diagnosis, never guessed here
}

/** The actual result a report shows: the recorded one, or a placeholder while a failure awaits diagnosis. */
function actualResultOf(e) {
  if (!e) return '';
  if (e.actual_result) return e.actual_result;
  return e.status === 'Failed' ? 'Pending diagnosis - see Technical Details.' : '';
}

/** Recompute the derived fields of a last_execution record in place. */
function derive(e) {
  e.execution_status = executionStatusOf(e);
  e.test_status = testStatusOf(e);
  if (!e.actual_result) e.actual_result = defaultActualResult(e);
  return e;
}

// ---------------------------------------------------------------- linked issues

const BUG_ID_RE = /^BUG-\d+$/i;
const TRACKER_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

function bugsDir(cwd, config) {
  return path.resolve(cwd, (config.paths && config.paths.bugs) || 'bugs');
}

/**
 * Turn what the pipeline was given (BUG-004, a bug .md path, a tracker URL, or a tracker key)
 * into a stored reference. A local bug must already exist on disk - a link is never left dangling.
 */
function issueRef(cwd, config, issue) {
  const raw = String(issue).trim();
  if (/^https?:\/\//i.test(raw)) {
    const key = raw.match(TRACKER_KEY_RE);
    return { id: key ? key[1] : raw, url: raw };
  }
  let file = null;
  if (BUG_ID_RE.test(raw)) file = path.join(bugsDir(cwd, config), `${raw.toUpperCase()}.md`);
  else if (/\.md$/i.test(raw)) file = path.resolve(cwd, raw);
  if (file) {
    if (!fs.existsSync(file)) throw new UsageError(`No bug file at ${rel(cwd, file)} - file the bug (bug-reporter) before linking it.`);
    return { id: path.basename(file, '.md'), path: rel(cwd, file) };
  }
  // A bare tracker key gets its browse URL when the Jira site is configured.
  const site = config.jira && config.jira.siteUrl;
  if (site && /^[A-Z][A-Z0-9_]+-\d+$/.test(raw)) return { id: raw, url: `${String(site).replace(/\/+$/, '')}/browse/${raw}` };
  return { id: raw };
}

/** Add issues to a test case's linked_issues (deduplicated by id). Returns the ids newly linked. */
function linkIssues(tc, refs) {
  tc.linked_issues = Array.isArray(tc.linked_issues) ? tc.linked_issues : [];
  const added = [];
  for (const ref of refs) {
    const existing = tc.linked_issues.find((l) => l.id === ref.id);
    if (existing) Object.assign(existing, ref);
    else {
      tc.linked_issues.push({ ...ref, linked_on: today() });
      added.push(ref.id);
    }
  }
  return added;
}

/** Older runs stored one free-text last_execution.linked_issue; fold it into linked_issues. */
function migrateLinkedIssue(tc, cwd, config) {
  const e = tc.last_execution;
  if (!e || !e.linked_issue) return;
  let ref;
  try {
    ref = issueRef(cwd, config, e.linked_issue);
  } catch {
    ref = { id: String(e.linked_issue) };
  }
  linkIssues(tc, [ref]);
  delete e.linked_issue;
}

/** Title/status/severity from a local bug file's frontmatter, read live so links never go stale. */
function bugMeta(cwd, ref) {
  if (!ref.path) return null;
  try {
    const text = fs.readFileSync(path.resolve(cwd, ref.path), 'utf8');
    const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    const fm = m ? parseYamlLite(m[1]) : {};
    return { title: fm.title || null, status: fm.status || null, severity: fm.severity || null };
  } catch {
    return { missing: true };
  }
}

/** All issues linked to a test case, including a not-yet-migrated legacy linked_issue. */
function linkedIssuesOf(tc) {
  const list = Array.isArray(tc.linked_issues) ? [...tc.linked_issues] : [];
  const legacy = tc.last_execution && tc.last_execution.linked_issue;
  if (legacy && !list.some((l) => l.id === legacy)) list.push({ id: String(legacy) });
  return list;
}

module.exports = {
  CLASSIFICATION_BUCKETS,
  DEFECT_CATEGORIES,
  TEST_STATUSES,
  EXECUTION_STATUSES,
  executionStatusOf,
  testStatusOf,
  actualResultOf,
  derive,
  issueRef,
  linkIssues,
  migrateLinkedIssue,
  bugMeta,
  linkedIssuesOf,
};
