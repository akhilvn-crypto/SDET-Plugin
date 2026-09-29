/**
 * Maps a Playwright JSON report back onto test cases via their @<SPEC>-TCnn tags,
 * and builds the lifecycle report. Reuses Playwright's own JSON reporter and the
 * artifacts (screenshot/trace/video) it already records - no second reporter.
 */
const fs = require('fs');
const path = require('path');
const { stripAnsi, nowIso, rel } = require('./util');
const { dimension } = require('./testcases');
const ex = require('./execution');

const { CLASSIFICATION_BUCKETS } = ex;

const TC_RE = /@?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-TC\d{2,})(?![A-Za-z0-9-])/g;

const STATUS_RANK = { Failed: 4, Flaky: 3, Passed: 2, Skipped: 1 };
const mapStatus = (s) => ({ expected: 'Passed', unexpected: 'Failed', flaky: 'Flaky', skipped: 'Skipped' }[s] || 'Failed');

function* walkSpecs(suite, titles = []) {
  const here = suite.title ? [...titles, suite.title] : titles;
  for (const spec of suite.specs || []) yield { spec, titlePath: [...here, spec.title] };
  for (const child of suite.suites || []) yield* walkSpecs(child, here);
}

function decodeAttachmentJson(att, cwd) {
  try {
    if (att.body) return JSON.parse(Buffer.from(att.body, 'base64').toString('utf8'));
    if (att.path) return JSON.parse(fs.readFileSync(path.resolve(cwd, att.path), 'utf8'));
  } catch {
    // unreadable attachment - ignore
  }
  return null;
}

/** Summarise an axe-core result attachment (named accessibility-scan*) into violation lines. */
function axeViolations(attachments, cwd) {
  const out = [];
  for (const att of attachments || []) {
    if (!/accessibility|axe/i.test(att.name || '') || !/json/.test(att.contentType || '')) continue;
    const data = decodeAttachmentJson(att, cwd);
    const violations = (data && (data.violations || (Array.isArray(data) ? data : []))) || [];
    for (const v of violations) {
      out.push({ id: v.id, impact: v.impact || null, help: v.help || v.description || '', nodes: (v.nodes || []).length });
    }
  }
  return out;
}

/** Parse a Playwright JSON report into per-test-case outcomes. */
function parseReport(report, cwd) {
  const byTc = {};
  for (const suite of report.suites || []) {
    for (const { spec, titlePath } of walkSpecs(suite)) {
      for (const test of spec.tests || []) {
        const haystack = [spec.title, ...(spec.tags || []), ...(test.tags || []), ...(test.annotations || []).map((a) => `${a.type} ${a.description || ''}`)].join(' ');
        const ids = new Set([...haystack.matchAll(TC_RE)].map((m) => m[1]));
        if (!ids.size) continue;
        const results = test.results || [];
        const last = results[results.length - 1] || {};
        const status = mapStatus(test.status);
        const errors = (last.errors && last.errors.length ? last.errors : last.error ? [last.error] : []).map((e) => stripAnsi(e.message || e.value || '').split('\n').slice(0, 6).join('\n'));
        const artifacts = (last.attachments || []).filter((a) => a.path).map((a) => ({ name: a.name, path: rel(cwd, a.path) }));
        const outcome = {
          status,
          project: test.projectName || null,
          test_title: titlePath.filter(Boolean).join(' › '),
          file: spec.file || null,
          duration_ms: results.reduce((sum, r) => sum + (r.duration || 0), 0),
          retries: Math.max(0, results.length - 1),
          error: errors.join('\n---\n').slice(0, 1500) || null,
          artifacts,
          accessibility_violations: axeViolations(last.attachments, cwd),
        };
        for (const id of ids) {
          const prev = byTc[id];
          // Across projects/browsers keep the worst outcome, so a single failing project is never hidden.
          if (!prev || STATUS_RANK[status] > STATUS_RANK[prev.status]) byTc[id] = { ...outcome, runs: (prev ? prev.runs : 0) + 1 };
          else prev.runs += 1;
        }
      }
    }
  }
  return byTc;
}

const firstLine = (text) => String(text || '').split('\n')[0].trim();

function applyResults(doc, byTc, config, cwd = process.cwd()) {
  const at = nowIso();
  const touched = [];
  for (const tc of doc.test_cases) {
    const r = byTc[tc.tc_id];
    if (!r) continue;
    const dim = dimension(tc);
    if (dim !== 'functional' && !config.testing[dim]) continue; // disabled dimension: not recorded
    ex.migrateLinkedIssue(tc, cwd, config);
    // A diagnosis (classification + actual result) carries forward only while it is the same failure;
    // a different failure message means it has to be diagnosed again.
    const prev = tc.last_execution;
    const keep = prev && prev.status === r.status && r.status !== 'Passed' && firstLine(prev.error) === firstLine(r.error) ? prev : {};
    tc.last_execution = ex.derive({
      at,
      status: r.status,
      project: r.project,
      test_title: r.test_title,
      duration_ms: r.duration_ms,
      retries: r.retries,
      error: r.error,
      artifacts: r.artifacts,
      ...(dim === 'accessibility' ? { accessibility_violations: r.accessibility_violations } : {}),
      ...(keep.classification ? { classification: keep.classification } : {}),
      ...(keep.actual_result && keep.actual_result_authored ? { actual_result: keep.actual_result, actual_result_authored: true } : {}),
    });
    touched.push(tc.tc_id);
  }
  return touched;
}

/**
 * What still has to be done for a run's failures before the run can be closed: every failure
 * needs a classification and a plain-language actual result, and every application defect a
 * linked bug. Flaky cases need a classification too (the retry hid a real failure).
 */
function pendingActions(doc, config) {
  const pending = [];
  for (const tc of doc.test_cases) {
    const e = tc.last_execution;
    if (tc.status !== 'Active' || !e || !['Failed', 'Flaky'].includes(e.status)) continue;
    const dim = dimension(tc);
    if (dim !== 'functional' && !config.testing[dim]) continue;
    const missing = [];
    if (!e.classification) missing.push('classification');
    if (e.status === 'Failed' && !e.actual_result_authored) missing.push('plain-language actual result (--actual)');
    if (ex.DEFECT_CATEGORIES.has(e.classification) && !ex.linkedIssuesOf(tc).length) missing.push('linked bug (--issue)');
    if (missing.length) pending.push({ tc: tc.tc_id, status: e.status, missing });
  }
  return pending;
}

function summarise(doc, config) {
  const dims = { functional: blank(), security: blank(), accessibility: blank() };
  for (const tc of doc.test_cases) {
    if (tc.status !== 'Active') continue;
    const dim = dimension(tc);
    const e = tc.last_execution;
    const d = dims[dim];
    d.cases++;
    if (!e) {
      d.not_executed++;
      continue;
    }
    d.tests++;
    d[{ Passed: 'passed', Failed: 'failed', Flaky: 'flaky', Skipped: 'skipped' }[e.status] || 'failed']++;
    if (e.status === 'Failed') {
      const testStatus = ex.testStatusOf(e);
      if (testStatus === 'Blocked') d.blocked++;
      d.failures.push({
        tc: tc.tc_id,
        title: tc.title,
        test_status: testStatus,
        classification: e.classification || null,
        bucket: CLASSIFICATION_BUCKETS[e.classification] || (e.classification ? 'Unknown' : 'Unclassified'),
        actual_result: e.actual_result_authored ? e.actual_result : null,
        error: e.error,
        linked_issues: ex.linkedIssuesOf(tc).map((l) => l.id),
      });
    }
    for (const v of e.accessibility_violations || []) d.violations.push({ tc: tc.tc_id, ...v });
  }
  if (!config.testing.security) dims.security = { disabled: true };
  if (!config.testing.accessibility) dims.accessibility = { disabled: true };
  return dims;
}

function blank() {
  return { cases: 0, tests: 0, passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0, not_executed: 0, failures: [], violations: [] };
}

function executionTotals(dims) {
  const totals = { tests: 0, passed: 0, failed: 0, blocked: 0, flaky: 0, skipped: 0 };
  for (const d of Object.values(dims)) {
    if (d.disabled) continue;
    for (const k of Object.keys(totals)) totals[k] += d[k];
  }
  return totals;
}

function formatLifecycle(record, doc, config) {
  const lines = [];
  const add = (label, value) => lines.push(`${label}:`, `  ${value}`, '');
  add(record.source === 'autonomous' ? 'Autonomous area' : 'Specification', `${record.spec_id}${record.name ? ` — ${record.name}` : ''}`);
  if (record.source !== 'autonomous') {
    add('Version', record.last_processed_version || record.spec_version || 'n/a');
    add('Location', record.spec_path || 'n/a');
    if (record.previous_paths && record.previous_paths.length) add('Previous locations', record.previous_paths.join(', '));
  }
  const explored = (record.history || []).some((h) => h.event === 'EXPLORED');
  add('Exploration', explored ? 'Completed' : 'Not recorded');
  add('Lifecycle status', record.status);
  for (const [gate, a] of Object.entries(record.approvals || {})) {
    const who = a.by ? ` by ${a.by} on ${String(a.at).slice(0, 10)}` : '';
    const label = { APPROVED: `Approved${who} (v${a.version})`, CHANGES_REQUESTED: `Changes requested${who}: ${a.note}`, PENDING: 'Awaiting review' }[a.status] || a.status;
    add(`Review (${gate})`, `${label}${a.rounds > 1 ? ` — ${a.rounds} review rounds` : ''}`);
  }
  if (!doc) {
    lines.push('Test Cases:', '  none generated yet', '');
    return lines.join('\n');
  }
  const active = doc.test_cases.filter((tc) => tc.status === 'Active');
  const delta = record.last_delta;
  add('Test Cases', `${active.length} active${doc.test_cases.length - active.length ? `, ${doc.test_cases.length - active.length} obsolete` : ''}`);
  if (delta) {
    add('New', delta.new.length);
    add('Updated', delta.updated.length);
    add('Unchanged', delta.unchanged.length);
    if (delta.obsoleted.length) add('Obsoleted', `${delta.obsoleted.length} (${delta.obsoleted.join(', ')})`);
    const a = delta.automation;
    const verdict = a.created.length && !a.updated.length && !a.unchanged.length ? 'Created' : a.created.length || a.updated.length || a.removed.length ? 'Updated' : 'Unchanged';
    add('Automation', `${verdict} (created ${a.created.length}, updated ${a.updated.length}, removed ${a.removed.length}, unchanged ${a.unchanged.length})`);
  }
  const dims = summarise(doc, config);
  const dimBlock = (label, d, isA11y) => {
    if (d.disabled) return add(label, 'Disabled');
    if (!d.cases) return add(label, 'No test cases');
    const parts = [`${d.tests} tests`, `${d.passed} passed`];
    if (d.failed) parts.push(`${d.failed} failed${d.blocked ? ` (${d.blocked} blocked - could not be verified, not a product failure)` : ''}`);
    if (d.flaky) parts.push(`${d.flaky} flaky`);
    if (d.skipped) parts.push(`${d.skipped} skipped`);
    if (d.not_executed) parts.push(`${d.not_executed} not executed`);
    if (isA11y && d.violations.length) parts.push(`${d.violations.length} violation${d.violations.length === 1 ? '' : 's'}`);
    lines.push(`${label}:`, ...parts.map((p) => `  ${p}`), '');
  };
  dimBlock('Functional', dims.functional);
  dimBlock('Security', dims.security);
  dimBlock('Accessibility', dims.accessibility, true);
  if (!dims.accessibility.disabled && dims.accessibility.violations.length) {
    lines.push('Accessibility Violations (automated scan):');
    for (const v of dims.accessibility.violations) lines.push(`  [${v.impact || 'n/a'}] ${v.id}: ${v.help} (${v.nodes} node${v.nodes === 1 ? '' : 's'}) — ${v.tc}`);
    lines.push('  Note: automated scanning covers a subset of WCAG; a clean scan is not proof of conformance. Manual evaluation was not performed.', '');
  }
  const failures = [dims.functional, dims.security, dims.accessibility].filter((d) => !d.disabled).flatMap((d) => d.failures);
  if (failures.length) {
    lines.push('Failures:');
    for (const f of failures) {
      lines.push(`  ${f.tc} ${f.title}`, `    Test status: ${f.test_status}`, `    Classification: ${f.bucket}${f.classification ? ` (${f.classification})` : ''}`);
      lines.push(`    Actual result: ${f.actual_result || 'not recorded yet (results classify ... --actual)'}`);
      if (f.linked_issues.length) lines.push(`    Linked issues: ${f.linked_issues.join(', ')}`);
      if (f.error) lines.push(`    Technical detail: ${f.error.split('\n')[0]}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { parseReport, applyResults, pendingActions, summarise, executionTotals, formatLifecycle, CLASSIFICATION_BUCKETS };
