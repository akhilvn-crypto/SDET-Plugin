/**
 * Per-specification lifecycle state: <stateDir>/state.json (default .sdet/state.json).
 *
 * One record per spec id (or autonomous area id) - upserted, never appended - so
 * re-running any command is idempotent. Complements, not replaces, the plugin's
 * existing per-run execution log (.lastrun.json): that file answers "what did the
 * last run do", this one answers "where is each spec in its lifecycle".
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, nowIso, rel, UsageError } = require('./util');

const STAGES = [
  'DISCOVERED',
  'EXPLORED',
  'TEST_CASES_GENERATED',
  'AWAITING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'AUTOMATION_GENERATED',
  'EXECUTED',
  'AUTOMATED',
  'AUTOMATION_INCOMPLETE',
  'BLOCKED',
];
const HISTORY_CAP = 50;

function stateDir(cwd, config) {
  return path.resolve(cwd, config.paths.stateDir || '.sdet');
}

function statePath(cwd, config) {
  return path.join(stateDir(cwd, config), 'state.json');
}

function loadState(cwd, config) {
  const state = readJson(statePath(cwd, config), null) || { schemaVersion: 1, specs: {} };
  state.specs = state.specs || {};
  return state;
}

function saveState(cwd, config, state) {
  state.updatedAt = nowIso();
  writeJson(statePath(cwd, config), state);
}

function pushHistory(record, event, detail) {
  record.history = [...(record.history || []), { at: nowIso(), event, ...(detail ? { detail } : {}) }].slice(-HISTORY_CAP);
}

function blankRecord(id, source) {
  return {
    spec_id: id,
    source,
    name: null,
    spec_path: null,
    previous_paths: [],
    spec_version: null,
    spec_hash: null,
    last_processed_version: null,
    last_processed_hash: null,
    last_processed_at: null,
    snapshot: null,
    status: 'NEW',
    test_cases_file: null,
    test_cases: [],
    automation: { files: [], mapping: {} },
    last_delta: null,
    last_execution: null,
    history: [],
  };
}

function upsert(state, id, source = 'spec') {
  if (!state.specs[id]) state.specs[id] = blankRecord(id, source);
  return state.specs[id];
}

function setStage(state, id, stage, { source, spec, name, note } = {}) {
  if (!STAGES.includes(stage)) throw new UsageError(`Unknown stage "${stage}". One of: ${STAGES.join(', ')}`);
  const record = upsert(state, id, source || 'spec');
  if (name) record.name = name;
  if (spec) {
    record.name = record.name || spec.name;
    if (record.spec_path && record.spec_path !== spec.path && !record.previous_paths.includes(record.spec_path)) {
      record.previous_paths.push(record.spec_path);
    }
    record.spec_path = spec.path;
    record.spec_version = spec.version || '1';
    record.spec_hash = spec.hash;
  }
  // Re-entering the same stage with the same detail (idempotent re-run) adds no duplicate history row.
  const last = (record.history || [])[record.history.length - 1];
  record.status = stage;
  if (!last || last.event !== stage || (note && last.detail !== note)) pushHistory(record, stage, note);
  return record;
}

function relocate(state, id, newPath) {
  const record = state.specs[id];
  if (!record) throw new UsageError(`No state record for ${id}`);
  if (record.spec_path === newPath) return { record, changed: false };
  if (record.spec_path && !record.previous_paths.includes(record.spec_path)) record.previous_paths.push(record.spec_path);
  pushHistory(record, 'SPEC_MOVED', `${record.spec_path} -> ${newPath}`);
  record.spec_path = newPath;
  return { record, changed: true };
}

function snapshotSpec(cwd, config, spec) {
  const file = path.join(stateDir(cwd, config), 'snapshots', spec.id, `v${spec.version || 1}-${spec.hash.slice(0, 8)}.json`);
  writeJson(file, { id: spec.id, version: spec.version, path: spec.path, hash: spec.hash, items: spec.items, text: spec.text });
  return rel(cwd, file);
}

function loadSnapshot(cwd, record) {
  if (!record || !record.snapshot) return null;
  return readJson(path.resolve(cwd, record.snapshot), null);
}

function archiveTestCases(cwd, config, id, tcFile, doc) {
  const version = (doc.meta && doc.meta.version) || '0';
  const target = path.join(stateDir(cwd, config), 'history', id, `test-cases.v${version}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.resolve(cwd, tcFile), target);
  return rel(cwd, target);
}

module.exports = {
  STAGES,
  stateDir,
  statePath,
  loadState,
  saveState,
  upsert,
  setStage,
  relocate,
  pushHistory,
  snapshotSpec,
  loadSnapshot,
  archiveTestCases,
};
