/**
 * Issue logs: the Story -> Spec -> Test Case -> Automation -> Result -> Bug traceability the team
 * reads, rebuilt from state on every run (never hand-edited):
 *
 *   <paths.issueLogs>/TRACEABILITY.md     master matrix, one row per test case (x linked bug)
 *   <paths.issueLogs>/<ID>.md             one story/spec: summary, spec versions, cases, bugs, run history
 *   <paths.issueLogs>/traceability.json   the same data; also the durable home of the run history
 *
 * Run history is the only thing not derivable from current state (last_execution is overwritten by
 * each run), so it is appended here - keyed by the run's timestamp, so rewriting is idempotent.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, rel, nowIso } = require('./util');
const tcs = require('./testcases');
const ex = require('./execution');
const jira = require('./jira');

const RUN_HISTORY_CAP = 200;

function logDir(cwd, config) {
  return path.resolve(cwd, config.paths.issueLogs || 'issue-logs');
}

/** Markdown link from a file in the issue-logs folder to a project-relative path. */
function linkFrom(cwd, config, label, target) {
  if (!target) return label;
  const href = path.relative(logDir(cwd, config), path.resolve(cwd, target)).split(path.sep).join('/');
  return `[${label}](${encodeURI(href)})`;
}

const cell = (v) => String(v == null || v === '' ? '—' : v).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** Every bug linked to a test case, local and Jira, joined through the registry. */
function bugsOf(cwd, config, tc, registry) {
  const byLocal = new Map(Object.values(registry.bugs).filter((b) => b.local_bug).map((b) => [b.local_bug, b]));
  const out = [];
  const seenJira = new Set();
  for (const ref of ex.linkedIssuesOf(tc)) {
    const id = String(ref.id);
    if (/^BUG-\d+$/i.test(id)) {
      const meta = ex.bugMeta(cwd, ref) || {};
      const j = byLocal.get(id.toUpperCase());
      if (j) seenJira.add(j.jira_key);
      out.push({ local: id.toUpperCase(), local_path: ref.path || null, title: meta.title || null, status: meta.status || null, severity: meta.severity || null, jira: j ? j.jira_key : null, jira_url: j ? j.url : null, link_type: j ? j.link_type || null : null });
    } else if (jira.KEY_RE.test(id)) {
      if (seenJira.has(id)) continue;
      const j = registry.bugs[id];
      seenJira.add(id);
      out.push({ local: j && j.local_bug ? j.local_bug : null, local_path: null, title: null, status: null, severity: null, jira: id, jira_url: (j && j.url) || ref.url || jira.issueUrl(config, id), link_type: j ? j.link_type || null : null });
    } else {
      out.push({ local: null, local_path: null, title: null, status: null, severity: null, jira: null, jira_url: ref.url || null, link_type: null, other: id });
    }
  }
  // A Jira bug recorded for this case that the test case does not list (e.g. reused on a later run).
  for (const j of Object.values(registry.bugs)) {
    if (!j.test_cases.includes(tc.tc_id) || seenJira.has(j.jira_key)) continue;
    if (j.local_bug && out.some((b) => b.local === j.local_bug)) continue;
    out.push({ local: j.local_bug || null, local_path: null, title: null, status: null, severity: null, jira: j.jira_key, jira_url: j.url, link_type: j.link_type || null });
  }
  // A local bug file named by the registry but not linked on the test case still needs its live status.
  for (const b of out) {
    if (b.local && !b.status) {
      const p = rel(cwd, path.join(config.paths.bugs || 'bugs', `${b.local}.md`));
      const meta = ex.bugMeta(cwd, { path: p });
      if (meta && !meta.missing) Object.assign(b, { local_path: p, title: b.title || meta.title, status: meta.status, severity: meta.severity });
    }
  }
  return out;
}

function collect(cwd, config, state, ids) {
  const registry = jira.loadRegistry(cwd, config);
  const entries = [];
  for (const id of ids) {
    const record = state.specs[id];
    if (!record) continue;
    const { file, doc } = tcs.loadDoc(cwd, config, id, record);
    const story = jira.loadStory(cwd, config, id);
    const specFm = record.spec_path ? jira.frontmatterOf(path.resolve(cwd, record.spec_path)) : {};
    const isStory = Boolean(story) || specFm.source === 'jira';
    const cases = (doc ? doc.test_cases : []).map((tc) => {
      const e = tc.last_execution;
      return {
        tc_id: tc.tc_id,
        title: tc.title,
        req_id: tc.req_id,
        spec_scenario: tc.spec_scenario || null,
        test_type: tc.test_type,
        priority: tc.priority,
        status: tc.status,
        automation_status: tc.automation_status,
        automation: ((tc.automation && tc.automation.tests) || []).map((t) => ({ file: t.file, line: t.line, title: t.title || null })),
        result: e ? e.test_status || null : null,
        executed_at: e ? e.at || null : null,
        classification: e ? e.classification || null : null,
        actual_result: e ? ex.actualResultOf(e) || null : null,
        bugs: bugsOf(cwd, config, tc, registry),
      };
    });
    entries.push({
      id,
      name: record.name || (story && story.summary) || null,
      source: isStory ? 'jira' : record.source,
      story: isStory
        ? { key: id, summary: story ? story.summary : record.name, status: story ? story.status || null : null, url: (story && story.url) || specFm.jira_url || jira.issueUrl(config, id), updated: story ? story.updated : specFm.jira_updated || null }
        : null,
      spec: { path: record.spec_path, version: record.last_processed_version || record.spec_version, previous_paths: record.previous_paths || [] },
      lifecycle: record.status,
      test_cases_file: doc ? rel(cwd, file.replace(/\.json$/i, '.md')) : null,
      last_execution: record.last_execution || null,
      cases,
      jira_bugs: Object.values(registry.bugs).filter((b) => b.story === id),
    });
  }
  return entries;
}

function appendRuns(previous, entries) {
  const runs = { ...((previous && previous.runs) || {}) };
  for (const e of entries) {
    const list = runs[e.id] ? [...runs[e.id]] : [];
    const le = e.last_execution;
    if (le && le.at && !list.some((r) => r.at === le.at)) {
      const bugs = [...new Set(e.cases.flatMap((c) => c.bugs.map((b) => b.jira || b.local).filter(Boolean)))];
      list.push({ at: le.at, spec_version: e.spec.version, tests: le.tests, passed: le.passed, failed: le.failed, blocked: le.blocked, flaky: le.flaky, skipped: le.skipped, bugs });
    }
    runs[e.id] = list.slice(-RUN_HISTORY_CAP);
  }
  return runs;
}

function specVersions(state, id) {
  const record = state.specs[id];
  return ((record && record.history) || []).filter((h) => h.event === 'AUTOMATED' || h.event === 'AUTOMATION_INCOMPLETE').map((h) => ({ at: h.at, detail: h.detail || '' }));
}

function renderMatrix(cwd, config, entries, jiraOn) {
  const header = jiraOn
    ? ['Story', 'Spec (ver)', 'Test Case', 'Automation', 'Last Result', 'Local Bug', 'Jira Bug', 'Link', 'Bug Status']
    : ['Spec (ver)', 'Test Case', 'Automation', 'Last Result', 'Local Bug', 'Bug Status'];
  const rows = [];
  for (const e of entries) {
    const story = e.story ? (e.story.url ? `[${e.story.key}](${e.story.url})` : e.story.key) : '—';
    const spec = `${linkFrom(cwd, config, e.id, e.spec.path)} (v${e.spec.version || '?'})`;
    for (const c of e.cases.filter((x) => x.status === 'Active' || x.bugs.length)) {
      const tc = `${linkFrom(cwd, config, c.tc_id, e.test_cases_file)} — ${cell(c.title)}${c.status === 'Obsolete' ? ' *(obsolete)*' : ''}`;
      const auto = c.automation.length ? c.automation.map((t) => `\`${t.file}\``).filter((v, i, a) => a.indexOf(v) === i).join(', ') : c.automation_status;
      const bugs = c.bugs.length ? c.bugs : [null];
      for (const b of bugs) {
        const local = b && b.local ? linkFrom(cwd, config, b.local, b.local_path) : b && b.other ? b.other : '—';
        const jb = b && b.jira ? (b.jira_url ? `[${b.jira}](${b.jira_url})` : b.jira) : '—';
        const status = b ? b.status || '—' : '—';
        const common = [cell(auto), cell(c.result || 'Not Run'), local];
        rows.push(jiraOn ? [story, spec, tc, ...common, jb, cell(b && b.link_type), cell(status)] : [spec, tc, ...common, cell(status)]);
      }
    }
  }
  const lines = [
    '# Traceability Matrix',
    '',
    `_Generated ${nowIso().slice(0, 16).replace('T', ' ')} UTC by the SDET pipeline — do not edit by hand (see README.md)._`,
    '',
  ];
  const totals = entries.reduce(
    (t, e) => {
      const active = e.cases.filter((c) => c.status === 'Active');
      t.specs += 1;
      t.cases += active.length;
      t.automated += active.filter((c) => c.automation_status === 'Automated').length;
      t.pass += active.filter((c) => c.result === 'Pass').length;
      t.fail += active.filter((c) => c.result === 'Fail').length;
      t.blocked += active.filter((c) => c.result === 'Blocked').length;
      for (const c of e.cases) for (const b of c.bugs) t.bugs.add(b.jira || b.local || b.other);
      return t;
    },
    { specs: 0, cases: 0, automated: 0, pass: 0, fail: 0, blocked: 0, bugs: new Set() },
  );
  lines.push(
    `**${totals.specs}** ${jiraOn ? 'stories/specs' : 'specs'} · **${totals.cases}** active test cases · **${totals.automated}** automated · last results: **${totals.pass}** pass, **${totals.fail}** fail, **${totals.blocked}** blocked · **${totals.bugs.size}** linked bugs`,
    '',
  );
  if (!rows.length) lines.push('No test cases recorded yet.');
  else {
    lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
    rows.forEach((r) => lines.push(`| ${r.join(' | ')} |`));
  }
  lines.push('', 'Per-story / per-spec detail: ' + (entries.map((e) => `[${e.id}](${encodeURI(`${e.id}.md`)})`).join(' · ') || '—'));
  return lines.join('\n') + '\n';
}

function renderEntry(cwd, config, e, runs, versions) {
  const L = [];
  L.push(`# ${e.id}${e.name ? ` — ${e.name}` : ''}`, '', `_Generated by the SDET pipeline — do not edit by hand. Back to the [traceability matrix](TRACEABILITY.md)._`, '');
  if (e.story) {
    L.push('## User story', '');
    L.push(`- **Jira:** ${e.story.url ? `[${e.story.key}](${e.story.url})` : e.story.key}`);
    L.push(`- **Summary:** ${e.story.summary || '—'}`);
    if (e.story.status) L.push(`- **Story status (when last fetched):** ${e.story.status}`);
    if (e.story.updated) L.push(`- **Story last updated in Jira:** ${e.story.updated}`);
    L.push('');
  }
  L.push('## Specification', '');
  L.push(`- **Spec:** ${linkFrom(cwd, config, e.spec.path || e.id, e.spec.path)} (version ${e.spec.version || '?'})`);
  if (e.spec.previous_paths.length) L.push(`- **Previously at:** ${e.spec.previous_paths.join(', ')}`);
  L.push(`- **Lifecycle:** ${e.lifecycle}`);
  if (e.test_cases_file) L.push(`- **Test cases:** ${linkFrom(cwd, config, e.test_cases_file, e.test_cases_file)}`);
  if (versions.length) {
    L.push('', '| Processed | What changed |', '|---|---|');
    versions.forEach((v) => L.push(`| ${v.at.slice(0, 16).replace('T', ' ')} | ${cell(v.detail)} |`));
  }
  L.push('', '## Test cases', '');
  if (!e.cases.length) L.push('No test cases yet.');
  else {
    L.push('| Test Case | Type | Priority | Automation | Last Result | Actual Result | Bugs |', '|---|---|---|---|---|---|---|');
    for (const c of e.cases) {
      const auto = c.automation.length ? c.automation.map((t) => `\`${t.file}:${t.line}\``).join('<br>') : c.automation_status;
      const bugs = c.bugs.map((b) => [b.local, b.jira && `${b.jira}${b.link_type ? ` (${b.link_type})` : ''}`, b.other].filter(Boolean).join(' / ')).join('<br>');
      const actual = c.result && c.result !== 'Pass' ? c.actual_result : '';
      L.push(`| ${c.tc_id} — ${cell(c.title)}${c.status === 'Obsolete' ? ' *(obsolete)*' : ''} | ${c.test_type} | ${c.priority} | ${auto} | ${cell(c.result || 'Not Run')} | ${cell(actual)} | ${cell(bugs)} |`);
    }
  }
  const allBugs = new Map();
  for (const c of e.cases) for (const b of c.bugs) {
    const k = b.jira || b.local || b.other;
    const cur = allBugs.get(k) || { ...b, cases: [] };
    cur.cases.push(c.tc_id);
    allBugs.set(k, cur);
  }
  L.push('', '## Bugs', '');
  if (!allBugs.size) L.push('No bugs linked.');
  else {
    L.push('| Jira Bug | Link to story | Local Bug | Title | Severity | Status | Found by |', '|---|---|---|---|---|---|---|');
    for (const b of allBugs.values()) {
      const jb = b.jira ? (b.jira_url ? `[${b.jira}](${b.jira_url})` : b.jira) : b.other || '—';
      L.push(`| ${jb} | ${cell(b.link_type)} | ${b.local ? linkFrom(cwd, config, b.local, b.local_path) : '—'} | ${cell(b.title)} | ${cell(b.severity)} | ${cell(b.status)} | ${b.cases.join(', ')} |`);
    }
  }
  L.push('', '## Run history', '');
  if (!runs.length) L.push('Not executed yet.');
  else {
    L.push('| Run (UTC) | Spec ver | Tests | Pass | Fail | Blocked | Flaky | Skipped | Bugs linked |', '|---|---|---|---|---|---|---|---|---|');
    [...runs].reverse().forEach((r) => L.push(`| ${r.at.slice(0, 16).replace('T', ' ')} | ${r.spec_version || '—'} | ${r.tests} | ${r.passed} | ${r.failed} | ${r.blocked} | ${r.flaky} | ${r.skipped} | ${cell(r.bugs.join(', '))} |`));
  }
  return L.join('\n') + '\n';
}

/** Rebuild the issue logs. `ids` limits which per-entry files are rewritten; the matrix always covers everything. */
function write(cwd, config, state, ids = []) {
  const dir = logDir(cwd, config);
  const jsonFile = path.join(dir, 'traceability.json');
  const previous = readJson(jsonFile, null);
  const allIds = Object.keys(state.specs).sort();
  const entries = collect(cwd, config, state, allIds);
  const runs = appendRuns(previous, entries);
  const jiraOn = Boolean(config.jira && config.jira.enabled) || entries.some((e) => e.story);

  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) fs.copyFileSync(path.join(__dirname, '..', '..', 'templates', 'issue-logs.README.md'), readme);
  const written = [];
  writeText(path.join(dir, 'TRACEABILITY.md'), renderMatrix(cwd, config, entries, jiraOn));
  written.push(rel(cwd, path.join(dir, 'TRACEABILITY.md')));
  const only = new Set(ids.length ? ids : allIds);
  for (const e of entries) {
    const f = path.join(dir, `${e.id}.md`);
    if (!only.has(e.id) && fs.existsSync(f)) continue;
    writeText(f, renderEntry(cwd, config, e, runs[e.id] || [], specVersions(state, e.id)));
    written.push(rel(cwd, f));
  }
  writeJson(jsonFile, { schemaVersion: 1, generated_at: nowIso(), entries, runs });
  written.push(rel(cwd, jsonFile));
  return { written, entries: entries.length };
}

module.exports = { write, logDir };
