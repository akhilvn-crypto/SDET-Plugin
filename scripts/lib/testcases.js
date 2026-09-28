/**
 * Test-case store: one JSON document per spec id, shaped after the qa-analyst
 * plugin's TestCaseDocument (meta / test_cases / not_covered / document_control /
 * release_history, each test case with tc_id, req_id, title, objective, test_type,
 * priority, preconditions and atomic steps[{step_number, action, expected_result,
 * test_data}]), extended with the spec-traceability and automation fields this
 * pipeline needs. The JSON is the source of truth; the .md next to it is rendered
 * from it and never hand-edited.
 *
 * Field ownership:
 *   - authored (by the /sdet skill):  everything except the fields below
 *   - script-managed (never hand-edit): automation.*, last_execution, linked_issues
 *     (last_execution carries execution_status, test_status and actual_result - see execution.js)
 *   - automation_status: authored when a case needs re-automation ("Needs Update"),
 *     otherwise kept in sync by `trace --write`.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, rel, today, escapeRegex, UsageError } = require('./util');
const ex = require('./execution');
const wb = require('./testcase-workbook');

const TEST_TYPES = ['Positive', 'Negative', 'Validation', 'Boundary', 'Edge', 'Permission', 'Integration', 'Security', 'Accessibility', 'Database', 'API'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const AUTOMATION_STATUSES = ['Not Automated', 'Automated', 'Needs Update', 'Manual', 'Blocked', 'Obsolete'];
const TC_STATUSES = ['Active', 'Obsolete'];
const TBD = 'TBD – Client/Project Input Required';
// Fields that describe what a test case *is*; a change to any of them is a test-case update.
const CONTENT_FIELDS = ['req_id', 'spec_scenario', 'title', 'objective', 'test_type', 'priority', 'preconditions', 'steps', 'security_relevance', 'accessibility_relevance', 'status'];

// Security/Accessibility coverage is gated by config (testing.security / testing.accessibility).
function dimension(tc) {
  if (tc.test_type === 'Security') return 'security';
  if (tc.test_type === 'Accessibility') return 'accessibility';
  return 'functional';
}

function tcFilePath(cwd, config, id) {
  return path.resolve(cwd, config.paths.testCases, `${id}.test-cases.json`);
}

function loadDoc(cwd, config, id, record) {
  const file = record && record.test_cases_file ? path.resolve(cwd, record.test_cases_file) : tcFilePath(cwd, config, id);
  return { file, doc: readJson(file, null) };
}

function skeleton({ id, source, spec, name }) {
  return {
    meta: {
      spec_id: id,
      spec_version: spec ? spec.version || '1' : null,
      source_doc: spec ? spec.path : `autonomous exploration: ${name || id}`,
      source,
      version: '0.0',
      generated_date: today(),
      changelog: [],
    },
    test_cases: [],
    not_covered: [],
    document_control: {
      title: `Test Cases – ${name || id}`,
      project_id: TBD,
      document_id: TBD,
      description: spec ? `Test cases generated from specification ${id}` : `Test cases generated from autonomous exploration (${id})`,
      prepared_by: TBD,
      prepared_date: today(),
      approved_date: TBD,
      master_template_id: TBD,
      version: '0.0',
    },
    release_history: [],
  };
}

function validateDoc(doc, { id, config, record }) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') return { errors: ['Test-case file is missing or not valid JSON.'], warnings };
  const meta = doc.meta || {};
  if (meta.spec_id !== id) errors.push(`meta.spec_id must be "${id}" (got ${JSON.stringify(meta.spec_id)}).`);
  if (!meta.version) errors.push('meta.version is required (e.g. "1.0"; bump it on every regeneration).');
  if (!Array.isArray(meta.changelog) || meta.changelog.length === 0) errors.push('meta.changelog needs at least one entry naming what this run changed.');
  if (!Array.isArray(doc.test_cases)) return { errors: [...errors, 'test_cases must be an array.'], warnings };

  const idRe = new RegExp(`^${escapeRegex(id)}-TC\\d{2,}$`);
  const seen = new Set();
  const titles = new Map();
  const previous = new Set((record && record.test_cases) || []);
  doc.test_cases.forEach((tc, i) => {
    const where = tc && tc.tc_id ? tc.tc_id : `test_cases[${i}]`;
    if (!tc || typeof tc !== 'object') return errors.push(`${where}: not an object.`);
    if (!idRe.test(tc.tc_id || '')) errors.push(`${where}: tc_id must look like ${id}-TC01.`);
    if (seen.has(tc.tc_id)) errors.push(`${where}: duplicate tc_id.`);
    seen.add(tc.tc_id);
    if (tc.spec_id !== id) errors.push(`${where}: spec_id must be "${id}".`);
    for (const f of ['req_id', 'title', 'objective']) if (!tc[f] || !String(tc[f]).trim()) errors.push(`${where}: ${f} is required.`);
    if (!TEST_TYPES.includes(tc.test_type)) {
      (tc.test_type === 'Edge Case' ? warnings : errors).push(`${where}: test_type "${tc.test_type}" should be one of ${TEST_TYPES.join(', ')}.`);
    }
    if (!PRIORITIES.includes(tc.priority)) errors.push(`${where}: priority must be High, Medium or Low.`);
    if (!TC_STATUSES.includes(tc.status)) errors.push(`${where}: status must be Active or Obsolete.`);
    if (!AUTOMATION_STATUSES.includes(tc.automation_status)) errors.push(`${where}: automation_status must be one of ${AUTOMATION_STATUSES.join(', ')}.`);
    if (tc.status === 'Obsolete' && tc.automation_status !== 'Obsolete') errors.push(`${where}: an Obsolete test case must have automation_status "Obsolete".`);
    for (const f of ['security_relevance', 'accessibility_relevance']) {
      if (typeof tc[f] !== 'string' || !tc[f].trim()) errors.push(`${where}: ${f} is required ("None" when not relevant).`);
    }
    if (!Array.isArray(tc.steps) || tc.steps.length === 0) errors.push(`${where}: at least one step is required.`);
    else {
      tc.steps.forEach((s, j) => {
        if (s.step_number !== j + 1) errors.push(`${where}: steps must be numbered 1..N contiguously (step ${j + 1} has ${s.step_number}).`);
        if (!s.action || !String(s.action).trim()) errors.push(`${where}: step ${j + 1} needs an action.`);
        if (!s.expected_result || !String(s.expected_result).trim()) errors.push(`${where}: step ${j + 1} needs an expected_result.`);
        if (/^(works|functions)( correctly| as expected)?\.?$/i.test(String(s.expected_result || '').trim())) {
          errors.push(`${where}: step ${j + 1} expected_result must be specific and verifiable, not "${s.expected_result}".`);
        }
        if (s.test_data !== undefined && typeof s.test_data !== 'string') errors.push(`${where}: step ${j + 1} test_data must be a string.`);
      });
    }
    // Config gating: a newly generated Security/Accessibility case while that dimension is disabled is an error.
    const dim = dimension(tc);
    if (dim !== 'functional' && !config.testing[dim] && tc.status === 'Active') {
      if (!previous.has(tc.tc_id)) errors.push(`${where}: ${tc.test_type} test cases must not be generated while testing.${dim} is false.`);
      else warnings.push(`${where}: testing.${dim} is disabled - this existing case is excluded from execution and reports.`);
    }
    if (tc.status === 'Active') {
      const key = String(tc.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (titles.has(key)) warnings.push(`${where}: same title as ${titles.get(key)} - possible redundant case.`);
      else titles.set(key, tc.tc_id);
    }
  });
  // Stable ids: a case that existed before may be marked Obsolete, but never silently deleted or renumbered.
  for (const prevId of previous) {
    if (!seen.has(prevId)) errors.push(`${prevId} existed in the last processed version but is missing - keep it and set status/automation_status to "Obsolete" instead of deleting it.`);
  }
  if (!Array.isArray(doc.not_covered || [])) errors.push('not_covered must be an array.');
  return { errors, warnings };
}

function contentOf(tc) {
  return JSON.stringify(CONTENT_FIELDS.map((f) => tc[f] ?? null));
}

function computeDelta(prevDoc, doc) {
  const prev = new Map(((prevDoc && prevDoc.test_cases) || []).map((tc) => [tc.tc_id, tc]));
  const delta = { new: [], updated: [], unchanged: [], obsoleted: [], automation: { created: [], updated: [], removed: [], unchanged: [] } };
  const mapped = (tc) => Boolean(tc && tc.automation && (tc.automation.tests || []).length);
  for (const tc of doc.test_cases) {
    const before = prev.get(tc.tc_id);
    if (!before) {
      if (tc.status === 'Active') delta.new.push(tc.tc_id);
    } else if (tc.status === 'Obsolete' && before.status !== 'Obsolete') delta.obsoleted.push(tc.tc_id);
    else if (contentOf(before) !== contentOf(tc)) delta.updated.push(tc.tc_id);
    else if (tc.status === 'Active') delta.unchanged.push(tc.tc_id);

    if (mapped(tc) && !mapped(before)) delta.automation.created.push(tc.tc_id);
    else if (!mapped(tc) && mapped(before)) delta.automation.removed.push(tc.tc_id);
    else if (mapped(tc) && delta.updated.includes(tc.tc_id)) delta.automation.updated.push(tc.tc_id);
    else if (mapped(tc)) delta.automation.unchanged.push(tc.tc_id);
  }
  return delta;
}

// ---------------------------------------------------------------- traceability scan

const TEST_FILE_RE = /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/;
const SCAN_EXCLUDE = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'blob-report', '.sdet']);
const TC_TAG_RE = /@([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-TC\d{2,})(?![A-Za-z0-9-])/g;
const TEST_CALL_RE = /\btest(?:\.(only|skip|fixme|fail|slow))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/;

function listTestFiles(cwd, dir = cwd, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SCAN_EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listTestFiles(cwd, full, out);
    else if (TEST_FILE_RE.test(e.name)) out.push(full);
  }
  return out;
}

/** Find every Playwright test carrying a @<SPEC>-TCnn tag. Filenames are never used for identity. */
function scanAutomation(cwd) {
  const byTc = {};
  for (const file of listTestFiles(cwd)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(TC_TAG_RE)) {
        let title = null;
        let modifier = null;
        let start = idx;
        for (let k = idx; k >= Math.max(0, idx - 8); k--) {
          const t = lines[k].match(TEST_CALL_RE);
          if (t) {
            modifier = t[1] || null;
            title = t[3];
            start = k;
            break;
          }
        }
        const block = lines.slice(start, idx + 6).join('\n');
        const entry = { file: rel(cwd, file), line: idx + 1, title, modifier, tags: [...new Set(block.match(/@[A-Za-z][\w-]*/g) || [])] };
        const list = (byTc[m[1]] = byTc[m[1]] || []);
        if (!list.some((e) => e.file === entry.file && e.title === entry.title)) list.push(entry);
      }
    });
  }
  return byTc;
}

function traceDoc(doc, id, scan) {
  const issues = [];
  const tcIds = new Set(doc.test_cases.map((tc) => tc.tc_id));
  const specTag = new RegExp(`^@${escapeRegex(id)}$`);
  for (const tc of doc.test_cases) {
    const found = scan[tc.tc_id] || [];
    if (tc.status === 'Active' && ['Automated', 'Needs Update'].includes(tc.automation_status) && !found.length) {
      issues.push({ level: 'error', tc: tc.tc_id, message: `marked ${tc.automation_status} but no test carries @${tc.tc_id}` });
    }
    if (tc.status === 'Obsolete' && found.length) {
      issues.push({ level: 'warning', tc: tc.tc_id, message: `obsolete but still automated in ${found.map((f) => `${f.file}:${f.line}`).join(', ')}` });
    }
    if (found.length > 1 && new Set(found.map((f) => f.file)).size !== found.length) {
      issues.push({ level: 'warning', tc: tc.tc_id, message: `tagged on ${found.length} tests in the same file - possible duplicate automation` });
    }
    for (const f of found) {
      if (!f.tags.some((t) => specTag.test(t))) issues.push({ level: 'warning', tc: tc.tc_id, message: `${f.file}:${f.line} is missing the spec tag @${id}` });
      const dim = dimension(tc);
      if (dim !== 'functional' && !f.tags.includes(`@${dim}`)) {
        issues.push({ level: 'error', tc: tc.tc_id, message: `${f.file}:${f.line} is a ${tc.test_type} test but lacks the @${dim} tag (needed so the config toggle can exclude it)` });
      }
      if (f.modifier === 'skip' || f.modifier === 'fixme') issues.push({ level: 'warning', tc: tc.tc_id, message: `${f.file}:${f.line} is test.${f.modifier}` });
    }
  }
  const prefix = `${id}-TC`;
  for (const [tcId, found] of Object.entries(scan)) {
    if (tcId.startsWith(prefix) && !tcIds.has(tcId)) {
      issues.push({ level: 'error', tc: tcId, message: `tag found in ${found.map((f) => `${f.file}:${f.line}`).join(', ')} but no such test case exists` });
    }
  }
  return issues;
}

/** Sync script-managed automation fields from the scan. Returns the list of changes made. */
function applyTrace(doc, scan) {
  const changes = [];
  for (const tc of doc.test_cases) {
    const found = scan[tc.tc_id] || [];
    const before = JSON.stringify(tc.automation || {});
    tc.automation = { files: [...new Set(found.map((f) => f.file))], tests: found.map((f) => ({ file: f.file, line: f.line, title: f.title })) };
    if (tc.status === 'Active' && !['Manual', 'Blocked', 'Needs Update'].includes(tc.automation_status)) {
      const next = found.length ? 'Automated' : 'Not Automated';
      if (tc.automation_status !== next) changes.push(`${tc.tc_id}: automation_status ${tc.automation_status} -> ${next}`);
      tc.automation_status = next;
    }
    if (before !== JSON.stringify(tc.automation)) changes.push(`${tc.tc_id}: automation -> ${tc.automation.files.join(', ') || '(none)'}`);
  }
  return changes;
}

// ---------------------------------------------------------------- markdown rendering

function cell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function table(headers, rows) {
  if (!rows.length) return '_None._';
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Linked issues as Markdown links relative to the rendered file, with the bug's live title/status. */
function issueLinks(tc, cwd, mdDir, config) {
  return ex
    .linkedIssuesOf(tc)
    .map((l) => {
      if (!l.path && !l.url) {
        try {
          l = { ...l, ...ex.issueRef(cwd, config, l.id) }; // legacy free-text id not yet migrated
        } catch {
          // no local bug file for it - show the id as given
        }
      }
      const meta = ex.bugMeta(cwd, l);
      let target = l.url || (l.path ? path.relative(mdDir, path.resolve(cwd, l.path)).split(path.sep).join('/') : null);
      if (target && /\s/.test(target)) target = `<${target}>`;
      const label = target ? `[${l.id}](${target})` : l.id;
      if (meta && meta.missing) return `${label} (bug file missing)`;
      const info = meta ? [meta.status, meta.severity].filter(Boolean).join(', ') : '';
      return `${label}${meta && meta.title ? ` — ${meta.title}` : ''}${info ? ` (${info})` : ''}`;
    })
    .join('; ');
}

function renderMarkdown(doc, { config, cwd = process.cwd(), mdFile = null }) {
  const mdDir = mdFile ? path.dirname(mdFile) : cwd;
  const meta = doc.meta || {};
  const control = doc.document_control || {};
  const active = doc.test_cases.filter((tc) => tc.status === 'Active');
  const countBy = (key) => active.reduce((acc, tc) => ({ ...acc, [tc[key]]: (acc[tc[key]] || 0) + 1 }), {});
  const typeCounts = countBy('test_type');
  const autoCounts = countBy('automation_status');
  const testStatusCounts = active.reduce((acc, tc) => {
    const s = ex.testStatusOf(tc.last_execution);
    return { ...acc, [s]: (acc[s] || 0) + 1 };
  }, {});
  const parts = [
    `# ${control.title || `Test Cases – ${meta.spec_id}`}`,
    `> Generated from \`${meta.source_doc}\` (spec **${meta.spec_id}**, version ${meta.spec_version ?? 'n/a'}). Rendered from \`${meta.spec_id}.test-cases.json\` — edit the JSON, never this file.`,
    '## A. Document Version Control',
    table(
      ['Field', 'Value'],
      [
        ['Title', control.title],
        ['Project ID', control.project_id],
        ['Document ID', control.document_id],
        ['Description', control.description],
        ['Prepared By', control.prepared_by],
        ['Prepared Date', control.prepared_date],
        ['Approved Date', control.approved_date],
        ['Master Template ID', control.master_template_id],
        ['Version', control.version || meta.version],
      ]
    ),
    '## B. Document Release History',
    table(
      ['Version', 'Date', 'Author', 'Reviewed By', 'Reviewed On', 'Approved By', 'Approved On', 'Reasons'],
      (doc.release_history || []).map((e) => [e.version, e.date, e.author, e.reviewed_by, e.reviewed_on, e.approved_by, e.approved_on, e.reasons])
    ),
    '## Summary',
    table(
      ['Metric', 'Value'],
      [
        ['Active test cases', active.length],
        ['Obsolete test cases', doc.test_cases.length - active.length],
        ['By type', Object.entries(typeCounts).map(([k, v]) => `${k}: ${v}`).join(', ')],
        ['By automation status', Object.entries(autoCounts).map(([k, v]) => `${k}: ${v}`).join(', ')],
        ['By test status', ex.TEST_STATUSES.filter((s) => testStatusCounts[s]).map((s) => `${s}: ${testStatusCounts[s]}`).join(', ')],
        ['Automation layers', [['functional', 'Functional (UI)'], ['api', 'API'], ['visual', 'Visual']].filter(([k]) => config.testing[k]).map(([, label]) => label).join(', ') || 'None'],
        ['Security testing', config.testing.security ? 'Enabled' : 'Disabled'],
        ['Accessibility testing', config.testing.accessibility ? 'Enabled' : 'Disabled'],
      ]
    ),
    '## Execution Results',
    active.some((tc) => tc.last_execution)
      ? table(
          ['TC ID', 'Title', 'Execution Status', 'Test Status', 'Actual Result', 'Linked Issues', 'Last Executed'],
          active.map((tc) => {
            const e = tc.last_execution;
            return [tc.tc_id, tc.title, ex.executionStatusOf(e), ex.testStatusOf(e), ex.actualResultOf(e), issueLinks(tc, cwd, mdDir, config), e ? e.at.slice(0, 16).replace('T', ' ') : ''];
          })
        )
      : '_Not executed yet._',
  ];

  const entries = doc.test_cases.map((tc) => {
    const e = tc.last_execution || {};
    const executed = Boolean(tc.last_execution);
    const tests = ((tc.automation && tc.automation.tests) || []).map((t) => `\`${t.file}:${t.line}\`${t.title ? ` — ${t.title}` : ''}`).join('; ');
    const bullets = [
      ['Requirement', tc.req_id],
      ['Spec Scenario', tc.spec_scenario],
      ['Test Type', tc.test_type],
      ['Priority', tc.priority],
      ['Status', tc.status],
      ['Objective', tc.objective],
      ['Preconditions', tc.preconditions],
      ['Security Relevance', tc.security_relevance],
      ['Accessibility Relevance', tc.accessibility_relevance],
      ['Automation Status', tc.automation_status],
      ['Automated Test', tests],
      ['Execution Status', ex.executionStatusOf(tc.last_execution)],
      ['Test Status', ex.testStatusOf(tc.last_execution)],
      ['Last Executed', executed ? `${e.at.slice(0, 16).replace('T', ' ')}${e.project ? ` (${e.project})` : ''}` : ''],
      ['Actual Result', ex.actualResultOf(tc.last_execution)],
      ['Failure Classification', e.classification ? `${ex.CLASSIFICATION_BUCKETS[e.classification] || 'Unknown'} (${e.classification})` : ''],
      ['Linked Issues', issueLinks(tc, cwd, mdDir, config)],
      ['Technical Details', ['Failed', 'Flaky'].includes(e.status) ? e.error : ''],
    ]
      .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
      .map(([k, v]) => `- **${k}:** ${String(v).replace(/\r?\n/g, ' ')}`)
      .join('\n');
    const steps = table(
      ['Step', 'Action', 'Test Data', 'Expected Result'],
      (tc.steps || []).map((s) => [s.step_number, s.action, s.test_data || '', s.expected_result])
    );
    return [`### ${tc.tc_id}: ${tc.title}${tc.status === 'Obsolete' ? ' _(Obsolete)_' : ''}`, bullets, steps].join('\n\n');
  });
  parts.push('## Test Cases', entries.length ? entries.join('\n\n---\n\n') : 'No test cases were generated for this run.');
  if ((doc.not_covered || []).length) {
    parts.push('## Not Covered', table(['Requirement', 'Reason'], doc.not_covered.map((n) => [n.req_id, n.reason])));
  }
  parts.push('## Changelog', table(['Version', 'Date', 'Changes'], (meta.changelog || []).map((c) => [c.version, c.date, c.changes])));
  return parts.join('\n\n') + '\n';
}

function writeDoc(file, doc) {
  writeJson(file, doc);
}

function writeMarkdown(file, doc, ctx) {
  const mdFile = file.replace(/\.json$/, '.md');
  writeText(mdFile, renderMarkdown(doc, { ...ctx, mdFile }));
  // Once exported, the Excel workbook is kept in step with every re-render. A workbook that
  // can't be rewritten (typically: open in Excel) must not fail the run that recorded results.
  if (fs.existsSync(wb.xlsxPathFor(file))) {
    try {
      wb.writeWorkbook(file, doc, { cwd: ctx.cwd });
    } catch (e) {
      console.error(`warning: could not refresh ${path.basename(wb.xlsxPathFor(file))} (${e.code || e.message}) - close it in Excel and run "testcases export ${doc.meta.spec_id}".`);
    }
  }
  return mdFile;
}

/** Write the Excel workbook next to the JSON (see testcase-workbook.js). */
function writeWorkbook(file, doc, ctx = {}) {
  return wb.writeWorkbook(file, doc, ctx);
}

module.exports = {
  TEST_TYPES,
  PRIORITIES,
  AUTOMATION_STATUSES,
  TC_STATUSES,
  dimension,
  tcFilePath,
  loadDoc,
  skeleton,
  validateDoc,
  computeDelta,
  scanAutomation,
  traceDoc,
  applyTrace,
  renderMarkdown,
  writeDoc,
  writeMarkdown,
  writeWorkbook,
  UsageError,
};
