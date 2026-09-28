#!/usr/bin/env node
/**
 * sdet.js - deterministic backbone of the spec-aware test-management layer that
 * wraps the existing sdet-pipeline agents (see skills/sdet/SKILL.md).
 *
 * Everything that must be exact and repeatable - config resolution, spec
 * discovery and identity, change detection, state persistence, test-case
 * validation/rendering, test-case <-> automation traceability, result ingestion
 * and reporting - lives here, so the /sdet skill never has to guess it. The
 * agents keep doing what only they can: exploring the app and writing tests.
 *
 * Run from the target project's root (all paths resolve against process.cwd()):
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/sdet.js" <group> <command> [args]
 *
 *   config    init [--force] [--example] [--set k=v]... | show [--json] | get <key> | set <key> <value> | validate
 *   specs     discover [--spec <path>]... [--json] | list [--json] | assign-id <file> [--id <ID>] | diff <ID> [--json]
 *   state     stage <ID> <STAGE> [--spec <path>] [--source autonomous --name "<area>"] [--note "..."] | relocate <ID> [--spec <path>] | commit <ID> [--spec <path>] | show <ID>
 *   testcases init <ID> [--source autonomous --name "<area>"] | path <ID> | validate <ID> | render <ID>
 *             export <ID | *.test-cases.md | *.test-cases.json>   (Excel workbook, Emvigo layout)
 *             set-status <ID> --tc <TC,...> --status "<automation status>"
 *   trace     [<ID>...] [--write] [--json]
 *   run-args  [<ID>...] [--tc <TC,...>] [--json]
 *   results   ingest [<report.json>] [--spec <ID>]... | pending [<ID>...] [--json]
 *             classify <TC_ID> <CATEGORY> [--actual "<plain-language actual result>"] [--issue <BUG-ID|URL|key>]...
 *   report    [<ID>...] [--json]
 *
 * Every command also accepts runtime config overrides, which win over sdet.config.json:
 *   --functional=true|false (UI via Playwright)  --api=...  --visual=...  (automation layers)
 *   --security=true|false  --accessibility=true|false  (test-case dimensions)
 *   --collection <Postman/OpenAPI/Insomnia file>  --spec-root <dir>[,<dir>]  --set <dotted.key>=<value>
 *
 * Exit codes: 0 ok, 1 validation/usage error, 2 unexpected failure.
 */
const fs = require('fs');
const path = require('path');
const { parseArgs, list, rel, readJson, escapeRegex, today, UsageError } = require('./lib/util');
const cfg = require('./lib/config');
const specs = require('./lib/specs');
const st = require('./lib/state');
const tcs = require('./lib/testcases');
const res = require('./lib/results');
const ex = require('./lib/execution');

const cwd = process.cwd();
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

function specIdOf(tcId) {
  const m = String(tcId).match(/^(.*)-TC\d{2,}$/);
  if (!m) throw new UsageError(`"${tcId}" is not a test case id (expected <SPEC_ID>-TCnn).`);
  return m[1];
}

function requireId(positional, what = 'spec id') {
  if (!positional[0]) throw new UsageError(`Missing ${what}.`);
  return positional[0];
}

function loadDocOrFail(config, state, id) {
  const { file, doc } = tcs.loadDoc(cwd, config, id, state.specs[id]);
  if (!doc) throw new UsageError(`No test-case file for ${id} at ${rel(cwd, file)} - run "testcases init ${id}" first.`);
  return { file, doc };
}

// ------------------------------------------------------------------ config

function cmdConfig(sub, positional, flags) {
  if (sub === 'init') {
    const file = cfg.projectConfigPath(cwd);
    if (fs.existsSync(file) && !flags.force) {
      out(`${rel(cwd, file)} already exists - left untouched. Use "config set" to change a value, or --force to recreate it from defaults.`);
      return 0;
    }
    // A fresh file = bundled defaults + whatever was requested on this command line.
    const defaults = cfg.loadDefaults();
    const fresh = cfg.deepMerge(defaults, {});
    for (const { key, value } of cfg.overridesFromFlags(flags, defaults)) cfg.setPath(fresh, key, value);
    cfg.normalize(fresh);
    const { errors, warnings } = cfg.validateConfig(fresh);
    if (errors.length) throw new UsageError(errors.join('\n'));
    const written = cfg.writeProjectConfig(cwd, fresh);
    out(`Created ${rel(cwd, written)}`);
    warnings.forEach((w) => out(`warning: ${w}`));
    if (flags.example) {
      const root = path.resolve(cwd, fresh.spec.roots[0] || 'specs');
      const example = path.join(root, 'EXAMPLE-LOGIN-001.yaml');
      if (!fs.existsSync(example)) {
        fs.mkdirSync(root, { recursive: true });
        fs.copyFileSync(path.join(__dirname, '..', 'templates', 'spec.example.yaml'), example);
        out(`Created example spec ${rel(cwd, example)} (edit or delete it)`);
      }
    }
    return 0;
  }
  const { config, sources } = cfg.loadConfig(cwd, flags);
  if (sub === 'show' || !sub) {
    if (flags.json) out({ config, sources });
    else {
      out(`Resolved configuration (defaults: plugin, project: ${sources.project ? rel(cwd, sources.project) : 'none - run "/sdet-config init"'}${sources.overrides.length ? `, overrides: ${sources.overrides.join(' ')}` : ''})`);
      out(config);
    }
    return 0;
  }
  if (sub === 'get') {
    out(cfg.getPath(config, requireId(positional, 'key')));
    return 0;
  }
  if (sub === 'set') {
    const [key, ...rest] = positional;
    if (!key || !rest.length) throw new UsageError('Usage: config set <dotted.key> <value>');
    const defaults = cfg.loadDefaults();
    if (cfg.getPath(defaults, key) === undefined && !flags.force) throw new UsageError(`Unknown key "${key}". Use --force to add it anyway.`);
    const file = cfg.projectConfigPath(cwd);
    const project = fs.existsSync(file) ? readJson(file) : cfg.deepMerge(defaults, {});
    if (!project) throw new UsageError(`${rel(cwd, file)} is not valid JSON.`);
    delete project.$comment;
    const value = cfg.coerce(rest.join(' '), cfg.getPath(defaults, key));
    cfg.setPath(project, key, value);
    cfg.normalize(project);
    const { errors, warnings } = cfg.validateConfig(cfg.deepMerge(defaults, project));
    if (errors.length) throw new UsageError(errors.join('\n'));
    cfg.writeProjectConfig(cwd, project);
    out(`${key} = ${JSON.stringify(value)}  (${rel(cwd, file)})`);
    warnings.forEach((w) => out(`warning: ${w}`));
    return 0;
  }
  if (sub === 'validate') {
    const { errors, warnings } = cfg.validateConfig(config);
    errors.forEach((e) => out(`error: ${e}`));
    warnings.forEach((w) => out(`warning: ${w}`));
    if (!errors.length) out(`OK${sources.project ? ` (${rel(cwd, sources.project)})` : ' (defaults only - no sdet.config.json yet)'}`);
    return errors.length ? 1 : 0;
  }
  throw new UsageError(`Unknown config command "${sub}".`);
}

// ------------------------------------------------------------------ specs

function cmdSpecs(sub, positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const state = st.loadState(cwd, config);
  if (sub === 'discover') {
    const result = specs.discover(cwd, config, state, list(flags.spec));
    if (flags.json) return out(result), 0;
    out(`Mode: ${result.mode}${result.mode === 'discovered' ? ` (roots: ${config.spec.roots.join(', ') || 'none'})` : ''}`);
    if (!result.results.length) out('No specification files found.');
    for (const r of result.results) {
      out(`${r.classification.padEnd(12)} ${r.id || '(no id)'}  v${r.version || '?'}  ${r.path}${r.previous_path ? `  (was ${r.previous_path})` : ''}${r.reason ? `  - ${r.reason}` : ''}`);
      if (r.suggestion) out(`             suggested id: ${r.suggestion.id} (${r.suggestion.reason})`);
      for (const w of r.warnings || []) out(`             warning: ${w}`);
    }
    for (const m of result.missing) out(`MISSING      ${m.id}  ${m.path}  - ${m.reason}`);
    return 0;
  }
  if (sub === 'list') {
    const result = specs.discover(cwd, config, state, list(flags.spec));
    const rows = result.results.map((r) => ({ ...r, record: r.id ? state.specs[r.id] : null }));
    for (const rec of Object.values(state.specs)) if (rec.source === 'autonomous') rows.push({ id: rec.spec_id, classification: 'AUTONOMOUS', path: '-', version: null, record: rec });
    for (const m of result.missing) rows.push({ ...m, record: state.specs[m.id] });
    const summary = rows.map((r) => {
      const { doc } = r.id ? tcs.loadDoc(cwd, config, r.id, r.record) : { doc: null };
      const active = doc ? doc.test_cases.filter((t) => t.status === 'Active') : [];
      const exec = r.record && r.record.last_execution;
      return {
        id: r.id || '(no id)',
        name: (r.record && r.record.name) || r.name || '',
        path: r.path,
        version: r.version,
        processed_version: r.record ? r.record.last_processed_version : null,
        classification: r.classification,
        status: r.record ? r.record.status : '-',
        test_cases: active.length,
        automated: active.filter((t) => t.automation_status === 'Automated').length,
        last_execution: exec ? `${exec.passed}/${exec.tests} passed${exec.failed ? `, ${exec.failed} failed` : ''} @ ${exec.at.slice(0, 16).replace('T', ' ')}` : 'never',
      };
    });
    if (flags.json) return out(summary), 0;
    if (!summary.length) return out('No specifications discovered and no autonomous records yet.'), 0;
    const header = ['ID', 'Version (cur/processed)', 'Discovery', 'Lifecycle', 'TCs', 'Automated', 'Last execution', 'Path'];
    const rowsTxt = summary.map((s) => [s.id, `${s.version || '-'}/${s.processed_version || '-'}`, s.classification, s.status, String(s.test_cases), String(s.automated), s.last_execution, s.path]);
    const widths = header.map((h, i) => Math.max(h.length, ...rowsTxt.map((r) => r[i].length)));
    const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
    out([line(header), line(widths.map((w) => '-'.repeat(w))), ...rowsTxt.map(line)].join('\n'));
    const onOff = (v) => (v ? 'enabled' : 'disabled');
    out(`\nFunctional (UI): ${onOff(config.testing.functional)} · API: ${onOff(config.testing.api)} · Visual: ${onOff(config.testing.visual)} · Security: ${onOff(config.testing.security)} · Accessibility: ${onOff(config.testing.accessibility)}`);
    return 0;
  }
  if (sub === 'assign-id') {
    const file = requireId(positional, 'spec file path');
    let id = flags.id;
    if (!id) {
      const spec = specs.readSpec(cwd, path.resolve(cwd, file));
      const discovered = specs.discover(cwd, config, state, [file]).results[0];
      id = discovered && discovered.suggestion ? discovered.suggestion.id : null;
      if (!id) throw new UsageError(`${spec.path} already has an id or no suggestion is available - pass --id.`);
    }
    const result = specs.assignId(cwd, config, state, file, String(id));
    out(`Assigned id ${result.id} to ${result.path}${result.versionAdded ? ' (added version: 1)' : ''}${result.adoptedExistingRecord ? ' - linked to the existing state record for this id' : ''}`);
    return 0;
  }
  if (sub === 'diff') {
    const id = requireId(positional);
    const record = state.specs[id];
    const current = specs.findSpecById(cwd, config, state, id);
    if (!current) throw new UsageError(`No spec file currently carries id ${id}.`);
    const snap = st.loadSnapshot(cwd, record);
    if (!snap) {
      const result = { id, previous_version: null, current_version: current.version, first_processing: true };
      return out(flags.json ? result : `${id} has not been processed before - everything is new.`), 0;
    }
    const delta = specs.itemDelta(snap.items, current.items);
    const lines = snap.hash === current.hash ? [] : specs.lineDiff(snap.text, current.text) || ['(file too large for a line diff)'];
    const result = { id, previous_version: snap.version, current_version: current.version, previous_path: snap.path, current_path: current.path, unchanged: snap.hash === current.hash, requirements: delta, text_diff: lines };
    if (flags.json) return out(result), 0;
    out(`${id}: v${snap.version} (${snap.path}) -> v${current.version} (${current.path})${result.unchanged ? '  [content unchanged]' : ''}`);
    for (const [k, d] of Object.entries(delta.lists)) {
      if (!d.added.length && !d.removed.length) continue;
      out(`\n[${k}]`);
      d.added.forEach((s) => out(`  + ${s}`));
      d.removed.forEach((s) => out(`  - ${s}`));
      if (d.unchanged.length) out(`  (${d.unchanged.length} unchanged)`);
    }
    for (const [k, d] of Object.entries(delta.scalars)) out(`\n[${k}] changed\n  before: ${d.before}\n  after:  ${d.after}`);
    if (lines.length) out(`\nLine diff:\n${lines.join('\n')}`);
    return 0;
  }
  throw new UsageError(`Unknown specs command "${sub}".`);
}

// ------------------------------------------------------------------ state

/**
 * Locate the file carrying a spec id: the path pinned with --spec (needed on first contact with a
 * spec outside spec.roots, e.g. an explicit "/sdet --spec" run), else the recorded path, else the roots.
 */
function resolveSpec(config, state, id, flags) {
  if (typeof flags.spec === 'string') {
    const spec = specs.readSpec(cwd, path.resolve(cwd, flags.spec));
    if (spec.id !== id) throw new UsageError(`${spec.path} carries id ${spec.id || '(none)'}, not ${id}.`);
    return spec;
  }
  const spec = specs.findSpecById(cwd, config, state, id);
  if (!spec) throw new UsageError(`No spec file carries id ${id} (pass --spec <path> if it lives outside spec.roots, or --source autonomous for exploration-only areas).`);
  return spec;
}

function cmdState(sub, positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const state = st.loadState(cwd, config);
  const id = requireId(positional);
  if (sub === 'show') return out(state.specs[id] || `No state record for ${id}.`), 0;
  if (sub === 'stage') {
    const stage = requireId(positional.slice(1), 'stage');
    const source = flags.source === 'autonomous' ? 'autonomous' : 'spec';
    let spec = null;
    if (source === 'spec') {
      spec = resolveSpec(config, state, id, flags);
    } else if (!new RegExp(config.spec.idPattern).test(id)) {
      throw new UsageError(`Autonomous id "${id}" must match spec.idPattern (e.g. ${config.autonomous.idPrefix}-CHECKOUT).`);
    }
    const record = st.setStage(state, id, stage, { source, spec, name: flags.name, note: flags.note });
    st.saveState(cwd, config, state);
    out(`${id}: ${record.status}`);
    return 0;
  }
  if (sub === 'relocate') {
    const spec = resolveSpec(config, state, id, flags);
    const { changed } = st.relocate(state, id, spec.path);
    st.saveState(cwd, config, state);
    out(changed ? `${id}: path updated to ${spec.path}` : `${id}: path already ${spec.path}`);
    return 0;
  }
  if (sub === 'commit') return commit(config, state, id, flags);
  throw new UsageError(`Unknown state command "${sub}".`);
}

/** Close out a processing run: validate, sync traceability, snapshot, compute the delta, persist. */
function commit(config, state, id, flags) {
  const record = state.specs[id];
  if (!record) throw new UsageError(`No state record for ${id} - nothing was processed.`);
  let spec = null;
  if (record.source !== 'autonomous') spec = resolveSpec(config, state, id, flags);
  const { file, doc } = loadDocOrFail(config, state, id);
  const { errors, warnings } = tcs.validateDoc(doc, { id, config, record });
  if (errors.length) throw new UsageError(`Test cases for ${id} are invalid - fix before committing:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  const scan = tcs.scanAutomation(cwd);
  tcs.applyTrace(doc, scan);
  const traceIssues = tcs.traceDoc(doc, id, scan);
  const prevDoc = record.test_cases_archive ? readJson(path.resolve(cwd, record.test_cases_archive), null) : null;
  const delta = tcs.computeDelta(prevDoc, doc);
  // Derived fields: keep the document pointing at where the spec lives now (it may have moved).
  if (spec) {
    doc.meta.source_doc = spec.path;
    doc.meta.spec_version = spec.version || '1';
  }
  if (doc.document_control) doc.document_control.version = doc.meta.version;
  tcs.writeDoc(file, doc);

  if (spec) {
    if (record.spec_path && record.spec_path !== spec.path) st.relocate(state, id, spec.path);
    record.spec_path = spec.path;
    record.spec_version = spec.version || '1';
    record.spec_hash = spec.hash;
    record.last_processed_version = spec.version || '1';
    record.last_processed_hash = spec.hash;
    record.snapshot = st.snapshotSpec(cwd, config, { ...spec, id });
  }
  record.last_processed_at = new Date().toISOString();
  record.test_cases_file = rel(cwd, file);
  record.test_cases = doc.test_cases.map((tc) => tc.tc_id);
  record.test_cases_archive = st.archiveTestCases(cwd, config, id, file, doc);
  const mapping = {};
  for (const tc of doc.test_cases) if (tc.automation && tc.automation.tests.length) mapping[tc.tc_id] = tc.automation.tests;
  record.automation = { files: [...new Set(Object.values(mapping).flat().map((t) => t.file))], mapping };
  record.last_delta = delta;
  const dims = res.summarise(doc, config);
  const executed = doc.test_cases.some((tc) => tc.last_execution);
  if (executed) {
    const latest = doc.test_cases.map((tc) => tc.last_execution && tc.last_execution.at).filter(Boolean).sort().pop();
    record.last_execution = { at: latest, ...res.executionTotals(dims) };
  }
  const pending = doc.test_cases.filter((tc) => {
    if (tc.status !== 'Active') return false;
    const dim = tcs.dimension(tc);
    if (dim !== 'functional' && !config.testing[dim]) return false;
    return ['Not Automated', 'Needs Update'].includes(tc.automation_status);
  });
  const blockingTrace = traceIssues.filter((i) => i.level === 'error');
  const status = pending.length || blockingTrace.length ? 'AUTOMATION_INCOMPLETE' : 'AUTOMATED';
  st.setStage(state, id, status, { note: `committed test cases v${doc.meta.version}: +${delta.new.length} new, ~${delta.updated.length} updated, =${delta.unchanged.length} unchanged, x${delta.obsoleted.length} obsoleted` });
  st.saveState(cwd, config, state);
  const md = tcs.writeMarkdown(file, doc, { config });

  out(`${id}: ${status}`);
  out(`  test cases: ${rel(cwd, file)} (+ ${rel(cwd, md)})`);
  out(`  delta: ${delta.new.length} new, ${delta.updated.length} updated, ${delta.unchanged.length} unchanged, ${delta.obsoleted.length} obsoleted`);
  if (pending.length) out(`  not yet automated: ${pending.map((t) => t.tc_id).join(', ')}`);
  warnings.forEach((w) => out(`  warning: ${w}`));
  traceIssues.forEach((i) => out(`  ${i.level}: ${i.tc} ${i.message}`));
  return 0;
}

// ------------------------------------------------------------------ test cases

function cmdTestcases(sub, positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const state = st.loadState(cwd, config);
  const id = requireId(positional);
  if (sub === 'path') return out(rel(cwd, tcs.loadDoc(cwd, config, id, state.specs[id]).file)), 0;
  if (sub === 'init') {
    const { file, doc } = tcs.loadDoc(cwd, config, id, state.specs[id]);
    if (doc) return out(`${rel(cwd, file)} already exists - edit it in place (idempotent: nothing recreated).`), 0;
    const source = flags.source === 'autonomous' ? 'autonomous' : 'spec';
    const spec = source === 'spec' ? specs.findSpecById(cwd, config, state, id) : null;
    if (source === 'spec' && !spec) throw new UsageError(`No spec file carries id ${id}.`);
    tcs.writeDoc(file, tcs.skeleton({ id, source, spec, name: flags.name || (spec && spec.name) }));
    out(`Created ${rel(cwd, file)}`);
    return 0;
  }
  if (sub === 'export') return exportWorkbook(config, state, id), 0;
  const { file, doc } = loadDocOrFail(config, state, id);
  if (sub === 'validate') {
    const { errors, warnings } = tcs.validateDoc(doc, { id, config, record: state.specs[id] });
    errors.forEach((e) => out(`error: ${e}`));
    warnings.forEach((w) => out(`warning: ${w}`));
    if (!errors.length) out(`OK - ${doc.test_cases.length} test cases in ${rel(cwd, file)}`);
    return errors.length ? 1 : 0;
  }
  if (sub === 'render') return out(`Rendered ${rel(cwd, tcs.writeMarkdown(file, doc, { config }))}`), 0;
  if (sub === 'set-status') {
    const ids = list(flags.tc);
    const status = flags.status;
    if (!ids.length || !tcs.AUTOMATION_STATUSES.includes(status)) throw new UsageError(`Usage: testcases set-status <ID> --tc <TC,...> --status "<${tcs.AUTOMATION_STATUSES.join('|')}>"`);
    for (const tcId of ids) {
      const tc = doc.test_cases.find((t) => t.tc_id === tcId);
      if (!tc) throw new UsageError(`${tcId} not found in ${rel(cwd, file)}`);
      tc.automation_status = status;
      if (status === 'Obsolete') tc.status = 'Obsolete';
    }
    tcs.writeDoc(file, doc);
    out(`${ids.join(', ')} -> ${status}`);
    return 0;
  }
  throw new UsageError(`Unknown testcases command "${sub}".`);
}

/**
 * Convert a spec's test cases to the Excel workbook. Takes the spec id or the rendered .md / the
 * .json itself; the workbook is always built from the JSON (the .md is rendered from it too), so
 * the two show the same thing. Valid content is required - the same bar as rendering for review.
 */
function exportWorkbook(config, state, target) {
  let file;
  let doc;
  if (/\.(md|json)$/i.test(target)) {
    file = path.resolve(cwd, target.replace(/\.md$/i, '.json'));
    doc = readJson(file, null);
    if (!doc) throw new UsageError(`No test-case JSON at ${rel(cwd, file)} - the Excel workbook is built from the JSON the .md is rendered from.`);
  } else {
    ({ file, doc } = loadDocOrFail(config, state, target));
  }
  const id = doc.meta && doc.meta.spec_id;
  if (!id) throw new UsageError(`${rel(cwd, file)} has no meta.spec_id - not a test-case document.`);
  const { errors } = tcs.validateDoc(doc, { id, config, record: state.specs[id] });
  if (errors.length) throw new UsageError(`Test cases for ${id} are invalid - fix before exporting:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  const xlsx = tcs.writeWorkbook(file, doc, { cwd });
  out(`Exported ${rel(cwd, xlsx)} (${doc.test_cases.length} test cases, from ${rel(cwd, file)}). It is refreshed automatically whenever the .md is re-rendered.`);
}

// ------------------------------------------------------------------ trace

function cmdTrace(positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const state = st.loadState(cwd, config);
  const ids = positional.length ? positional : Object.keys(state.specs);
  const scan = tcs.scanAutomation(cwd);
  const report = {};
  let errors = 0;
  for (const id of ids) {
    const { file, doc } = tcs.loadDoc(cwd, config, id, state.specs[id]);
    if (!doc) {
      report[id] = { error: 'no test-case file' };
      continue;
    }
    const changes = flags.write ? tcs.applyTrace(doc, scan) : [];
    if (flags.write && changes.length) tcs.writeDoc(file, doc);
    const issues = tcs.traceDoc(doc, id, scan);
    errors += issues.filter((i) => i.level === 'error').length;
    report[id] = {
      mapping: Object.fromEntries(doc.test_cases.map((tc) => [tc.tc_id, (scan[tc.tc_id] || []).map((f) => `${f.file}:${f.line}${f.title ? ` "${f.title}"` : ''}`)])),
      issues,
      changes,
    };
  }
  if (flags.json) out(report);
  else {
    for (const [id, r] of Object.entries(report)) {
      out(`${id}`);
      if (r.error) {
        out(`  ${r.error}`);
        continue;
      }
      for (const [tc, where] of Object.entries(r.mapping)) out(`  ${tc.padEnd(28)} ${where.length ? where.join('; ') : '(no automation)'}`);
      r.issues.forEach((i) => out(`  ${i.level}: ${i.tc} ${i.message}`));
      r.changes.forEach((c) => out(`  updated: ${c}`));
    }
  }
  return errors ? 1 : 0;
}

// ------------------------------------------------------------------ run-args

function cmdRunArgs(positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const tcIds = list(flags.tc);
  const grep = [
    ...positional.map((id) => `@${escapeRegex(id)}(?=\\s|$|-TC\\d)`),
    ...tcIds.map((tc) => `@${escapeRegex(tc)}(?![\\w-])`),
  ];
  const invert = [];
  if (!config.testing.security) invert.push('@security(?![\\w-])');
  if (!config.testing.accessibility) invert.push('@accessibility(?![\\w-])');
  const resultsFile = rel(cwd, path.join(st.stateDir(cwd, config), 'results', 'last-run.json'));
  const args = ['playwright', 'test'];
  if (grep.length) args.push('--grep', grep.join('|'));
  if (invert.length) args.push('--grep-invert', invert.join('|'));
  if (config.execution.playwrightProject) args.push(`--project=${config.execution.playwrightProject}`);
  args.push('--reporter=list,json,html');
  const env = { PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile, PLAYWRIGHT_HTML_OPEN: 'never' };
  const q = (a) => (/^[\w@./=,:-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  const qp = (a) => (/^[\w@./=,:-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`);
  fs.mkdirSync(path.dirname(path.resolve(cwd, resultsFile)), { recursive: true });
  const result = {
    args,
    env,
    results_file: resultsFile,
    bash: `${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ')} npx ${args.map(q).join(' ')}`,
    powershell: `${Object.entries(env).map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}'`).join('; ')}; npx ${args.map(qp).join(' ')}`,
    excluded: invert.length ? invert.map((i) => i.split('(')[0]) : [],
  };
  out(flags.json ? result : `bash:       ${result.bash}\npowershell: ${result.powershell}\nresults:    ${resultsFile}${result.excluded.length ? `\nexcluded (disabled in config): ${result.excluded.join(', ')}` : ''}`);
  return 0;
}

// ------------------------------------------------------------------ results

function cmdResults(sub, positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const state = st.loadState(cwd, config);
  if (sub === 'ingest') {
    const reportFile = path.resolve(cwd, positional[0] || path.join(st.stateDir(cwd, config), 'results', 'last-run.json'));
    const report = readJson(reportFile, null);
    if (!report) throw new UsageError(`Could not read a Playwright JSON report at ${rel(cwd, reportFile)} (run the tests with the command from "run-args").`);
    const byTc = res.parseReport(report, cwd);
    const specIds = list(flags.spec).length ? list(flags.spec) : [...new Set(Object.keys(byTc).map(specIdOf))];
    for (const id of specIds) {
      const { file, doc } = tcs.loadDoc(cwd, config, id, state.specs[id]);
      if (!doc) {
        out(`${id}: results found but no test-case file - skipped`);
        continue;
      }
      const touched = res.applyResults(doc, byTc, config, cwd);
      tcs.writeDoc(file, doc);
      tcs.writeMarkdown(file, doc, { config });
      if (state.specs[id] && touched.length) {
        const totals = res.executionTotals(res.summarise(doc, config));
        state.specs[id].last_execution = { at: new Date().toISOString(), ...totals };
        if (state.specs[id].status !== 'AUTOMATED') st.setStage(state, id, 'EXECUTED');
      }
      const unknown = Object.keys(byTc).filter((tc) => specIdOf(tc) === id && !doc.test_cases.some((t) => t.tc_id === tc));
      out(`${id}: recorded ${touched.length} test case result(s)${unknown.length ? `; tags with no test case: ${unknown.join(', ')}` : ''}`);
    }
    st.saveState(cwd, config, state);
    return 0;
  }
  if (sub === 'classify') {
    const [tcId, category] = positional;
    if (!tcId || !category) throw new UsageError('Usage: results classify <TC_ID> <CATEGORY> [--actual "<plain-language actual result>"] [--issue <BUG-001|tracker URL|key>]...');
    if (!res.CLASSIFICATION_BUCKETS[category]) throw new UsageError(`Unknown category "${category}". One of: ${Object.keys(res.CLASSIFICATION_BUCKETS).join(', ')}`);
    const id = specIdOf(tcId);
    const { file, doc } = loadDocOrFail(config, state, id);
    const tc = doc.test_cases.find((t) => t.tc_id === tcId);
    if (!tc) throw new UsageError(`${tcId} not found.`);
    const e = tc.last_execution;
    if (!e) throw new UsageError(`${tcId} has no recorded execution to classify.`);
    if (flags.actual === true || (flags.actual !== undefined && !String(flags.actual).trim())) throw new UsageError('--actual needs the actual result as text.');
    // Resolve every issue before changing anything, so a bad reference leaves the file untouched.
    const refs = list(flags.issue).map((i) => ex.issueRef(cwd, config, i));
    ex.migrateLinkedIssue(tc, cwd, config);
    e.classification = category;
    if (flags.actual !== undefined) {
      e.actual_result = String(flags.actual).trim();
      e.actual_result_authored = true;
    }
    const linked = ex.linkIssues(tc, refs);
    ex.derive(e);
    tcs.writeDoc(file, doc);
    tcs.writeMarkdown(file, doc, { config, cwd });
    out(`${tcId}: ${category} -> ${res.CLASSIFICATION_BUCKETS[category]}; test status ${e.test_status}${linked.length ? `; linked ${linked.join(', ')}` : ''}`);
    return 0;
  }
  if (sub === 'pending') {
    const ids = positional.length ? positional : Object.keys(state.specs);
    const rows = [];
    for (const id of ids) {
      const { doc } = tcs.loadDoc(cwd, config, id, state.specs[id]);
      if (doc) rows.push(...res.pendingActions(doc, config));
    }
    if (flags.json) out(rows);
    else if (!rows.length) out('OK - every failure has a classification, an actual result and (for defects) a linked bug.');
    else rows.forEach((r) => out(`${r.tc} (${r.status}): missing ${r.missing.join(', ')}`));
    return rows.length ? 1 : 0;
  }
  throw new UsageError(`Unknown results command "${sub}".`);
}

// ------------------------------------------------------------------ report

function cmdReport(positional, flags) {
  const { config } = cfg.loadConfig(cwd, flags);
  const state = st.loadState(cwd, config);
  const ids = positional.length ? positional : Object.keys(state.specs);
  if (!ids.length) return out('No specifications or autonomous areas have been processed yet.'), 0;
  const blocks = [];
  const json = {};
  for (const id of ids) {
    const record = state.specs[id];
    if (!record) {
      blocks.push(`${id}: no state record`);
      continue;
    }
    const { doc } = tcs.loadDoc(cwd, config, id, record);
    json[id] = { record, dimensions: doc ? res.summarise(doc, config) : null };
    blocks.push(res.formatLifecycle(record, doc, config));
  }
  if (flags.json) out(json);
  else out(`SDET lifecycle report — ${today()}\n${'='.repeat(40)}\n\n${blocks.join(`\n${'-'.repeat(40)}\n\n`)}`);
  return 0;
}

// ------------------------------------------------------------------ main

function main() {
  const [group, ...restArgv] = process.argv.slice(2);
  const takesSub = ['config', 'specs', 'state', 'testcases', 'results'].includes(group);
  const sub = takesSub ? restArgv[0] : null;
  const { positional, flags } = parseArgs(takesSub ? restArgv.slice(1) : restArgv);
  switch (group) {
    case 'config':
      return cmdConfig(sub, positional, flags);
    case 'specs':
      return cmdSpecs(sub, positional, flags);
    case 'state':
      return cmdState(sub, positional, flags);
    case 'testcases':
      return cmdTestcases(sub, positional, flags);
    case 'trace':
      return cmdTrace(positional, flags);
    case 'run-args':
      return cmdRunArgs(positional, flags);
    case 'results':
      return cmdResults(sub, positional, flags);
    case 'report':
      return cmdReport(positional, flags);
    default: {
      const lines = fs.readFileSync(__filename, 'utf8').split('\n');
      const from = lines.findIndex((l) => l.includes('Run from the target'));
      const to = lines.findIndex((l) => l.includes('Exit codes:'));
      if (group) console.error(`Unknown command "${group}".\n`);
      out(lines.slice(from, to + 1).map((l) => l.replace(/^ \*\s?/, '')).join('\n'));
      return group ? 1 : 0;
    }
  }
}

try {
  process.exitCode = main() || 0;
} catch (e) {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exitCode = 1;
  } else {
    console.error(e.stack || String(e));
    process.exitCode = 2;
  }
}
