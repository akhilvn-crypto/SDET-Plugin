/**
 * Maps a Playwright JSON report back onto test cases via their @<SPEC>-TCnn tags,
 * and builds the lifecycle report. Reuses Playwright's own JSON reporter and the
 * artifacts (screenshot/trace/video) it already records - no second reporter.
 */
const fs = require('fs');
const path = require('path');
const { stripAnsi, nowIso, rel } = require('./util');
const { dimension } = require('./testcases');

const TC_RE = /@?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-TC\d{2,})(?![A-Za-z0-9-])/g;

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

function applyResults(doc, byTc, config) {
  const at = nowIso();
  const touched = [];
  for (const tc of doc.test_cases) {
    const r = byTc[tc.tc_id];
    if (!r) continue;
    const dim = dimension(tc);
    if (dim !== 'functional' && !config.testing[dim]) continue; // disabled dimension: not recorded
    const keep = tc.last_execution && tc.last_execution.status === r.status && r.status !== 'Passed' ? tc.last_execution : {};
    tc.last_execution = {
      at,
      status: r.status,
      project: r.project,
      test_title: r.test_title,
      duration_ms: r.duration_ms,
      retries: r.retries,
      error: r.error,
      artifacts: r.artifacts,
      ...(dim === 'accessibility' ? { accessibility_violations: r.accessibility_violations } : {}),
      // A classification/linked issue made for the same failing status carries forward until the outcome changes.
      ...(keep.classification ? { classification: keep.classification } : {}),
      ...(keep.linked_issue ? { linked_issue: keep.linked_issue } : {}),
    };
    touched.push(tc.tc_id);
  }
  return touched;
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
    if (e.status === 'Failed') d.failures.push({ tc: tc.tc_id, title: tc.title, classification: e.classification || null, bucket: CLASSIFICATION_BUCKETS[e.classification] || (e.classification ? 'Unknown' : 'Unclassified'), error: e.error, linked_issue: e.linked_issue || null });
    for (const v of e.accessibility_violations || []) d.violations.push({ tc: tc.tc_id, ...v });
  }
  if (!config.testing.security) dims.security = { disabled: true };
  if (!config.testing.accessibility) dims.accessibility = { disabled: true };
  return dims;
}

function blank() {
  return { cases: 0, tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, not_executed: 0, failures: [], violations: [] };
}

function executionTotals(dims) {
  const totals = { tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
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
    if (d.failed) parts.push(`${d.failed} failed`);
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
      lines.push(`  ${f.tc} ${f.title}`, `    Classification: ${f.bucket}${f.classification ? ` (${f.classification})` : ''}${f.linked_issue ? ` — ${f.linked_issue}` : ''}`);
      if (f.error) lines.push(`    ${f.error.split('\n')[0]}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { parseReport, applyResults, summarise, executionTotals, formatLifecycle, CLASSIFICATION_BUCKETS };
