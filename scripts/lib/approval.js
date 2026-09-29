/**
 * Human-in-the-loop review gates. At each gate a person reads what the pipeline produced and
 * approves it - or sends it back - before the pipeline acts on it:
 *
 *   spec        the spec the pipeline itself wrote from a Jira story (source: jira), before test
 *               cases are generated. A spec a person wrote by hand needs no approval.
 *   test-cases  the test-case document for a spec / autonomous area, before automation.
 *   bug         a local bug (BUG-NNN) before it is filed to Jira (or added as a new occurrence
 *               on an existing Jira bug). Declined = never filed; the pipeline moves on.
 *
 * An approval is pinned to a content fingerprint, so it covers exactly what was read: edit the
 * content afterwards and the gate closes again until it is re-approved. For test cases the
 * fingerprint covers only authored content (CONTENT_FIELDS + not_covered), and for a bug the
 * jira_key / jira_url stamp is ignored, so script bookkeeping never invalidates an approval.
 *
 * Spec gates live on the spec's state record (`specs.<ID>.approvals.<gate>`), bug gates in
 * `bug_reviews.<BUG-NNN>.approvals.bug`; both change only through `$SDET approval`.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sha256, nowIso, today, rel, readJson, normalizeText, UsageError } = require('./util');
const specs = require('./specs');
const tcs = require('./testcases');

const SPEC_GATES = ['spec', 'test-cases'];
const GATES = [...SPEC_GATES, 'bug'];
const BUG_ID_RE = /^BUG-\d+$/;
const LOG_CAP = 20;
const TBD_RE = /^TBD/;

function requireGate(gate, id) {
  if (!GATES.includes(gate)) throw new UsageError(`--gate must be one of ${GATES.join(', ')}.`);
  if ((gate === 'bug') !== BUG_ID_RE.test(String(id))) {
    throw new UsageError(gate === 'bug' ? `The bug gate takes a local bug id (BUG-004), not "${id}".` : `"${id}" is a bug id - use --gate bug.`);
  }
  return gate;
}

function gateEnabled(config, gate) {
  const review = config.review || {};
  if (!review.enabled) return false;
  if (gate === 'spec') return review.spec !== false;
  if (gate === 'bug') return review.bugs !== false;
  return review.testCases !== false;
}

function isGeneratedSpec(spec) {
  const fm = spec && spec.text.match(/^---\n([\s\S]*?)\n---/);
  return Boolean(fm && /^source:\s*["']?jira["']?\s*$/m.test(fm[1]));
}

function docFingerprint(doc) {
  const tcHashes = Object.fromEntries(doc.test_cases.map((tc) => [tc.tc_id, sha256(tcs.contentOf(tc))]));
  const notCovered = JSON.stringify((doc.not_covered || []).map((n) => [n.req_id, n.reason]));
  return { hash: sha256(JSON.stringify([tcHashes, notCovered])), tc_hashes: tcHashes, version: (doc.meta && doc.meta.version) || null };
}

function bugFile(cwd, config, id) {
  return path.resolve(cwd, config.paths.bugs || 'bugs', `${id}.md`);
}

/** What a reviewer is being asked to approve right now: file, version and fingerprint. */
function fingerprint(cwd, config, state, id, gate) {
  if (gate === 'bug') {
    const file = bugFile(cwd, config, id);
    if (!fs.existsSync(file)) throw new UsageError(`No bug file at ${rel(cwd, file)} - bug-reporter files the local bug first.`);
    const text = normalizeText(fs.readFileSync(file, 'utf8'))
      .split('\n')
      .filter((l) => !/^jira_(key|url):/.test(l))
      .join('\n');
    return { applicable: true, file: rel(cwd, file), version: null, hash: sha256(text) };
  }
  const record = state.specs[id];
  if (gate === 'spec') {
    if (record && record.source === 'autonomous') return { applicable: false, reason: 'autonomous area - there is no spec to review' };
    const spec = specs.findSpecById(cwd, config, state, id);
    if (!spec) throw new UsageError(`No spec file carries id ${id}.`);
    if (!isGeneratedSpec(spec)) return { applicable: false, reason: 'human-authored spec - no approval needed', file: spec.path };
    return { applicable: true, file: spec.path, version: spec.version || '1', hash: spec.hash };
  }
  const { file, doc } = tcs.loadDoc(cwd, config, id, record);
  if (!doc) return { applicable: true, missing: `No test-case file for ${id} - generate the test cases first.` };
  return { applicable: true, file: rel(cwd, file.replace(/\.json$/, '.md')), source: rel(cwd, file), ...docFingerprint(doc) };
}

/** Where a gate's approval is kept: the spec's state record, or the bug's review record. */
function holder(state, id, gate, { create = false } = {}) {
  if (gate !== 'bug') return state.specs[id] || null;
  state.bug_reviews = state.bug_reviews || {};
  if (!state.bug_reviews[id] && create) state.bug_reviews[id] = { bug_id: id };
  return state.bug_reviews[id] || null;
}

/** Authored content of the last committed test-case version (pre-dates this gate, or approved earlier). */
function committedHash(cwd, record) {
  if (!record || !record.test_cases_archive) return null;
  const prev = readJson(path.resolve(cwd, record.test_cases_archive), null);
  return prev && Array.isArray(prev.test_cases) ? docFingerprint(prev).hash : null;
}

function changedSince(approvedTcs, currentTcs) {
  if (!approvedTcs) return Object.keys(currentTcs);
  return Object.keys(currentTcs).filter((tc) => approvedTcs[tc] !== currentTcs[tc]);
}

/**
 * Is this gate open? ok = the pipeline may act (automate / file to Jira). Reasons are written for
 * the person reading the pipeline output, not for the script.
 */
function check(cwd, config, state, id, gate) {
  if (gate === 'bug' && !(config.jira && config.jira.enabled)) return { ok: true, reason: 'Jira is off - nothing is filed' };
  if (!gateEnabled(config, gate)) return { ok: true, reason: 'review disabled in config' };
  const fp = fingerprint(cwd, config, state, id, gate);
  if (!fp.applicable) return { ok: true, reason: fp.reason };
  if (fp.missing) return { ok: false, reason: 'test cases not generated yet', status: 'NOT_REQUESTED', changed: [] };
  const record = holder(state, id, gate) || {};
  const a = (record.approvals || {})[gate];
  const since = (x) => `${x.by} on ${x.at.slice(0, 10)}`;
  if (a && a.status === 'APPROVED' && a.hash === fp.hash) return { ok: true, reason: `approved by ${since(a)}${a.version ? ` (v${a.version})` : ''}`, approval: a };
  if (gate === 'test-cases' && fp.hash === committedHash(cwd, record)) return { ok: true, reason: 'unchanged since the last committed version' };
  if (gate === 'spec' && record.last_processed_hash === fp.hash) return { ok: true, reason: 'unchanged since the last processed version' };
  const changed = gate === 'test-cases' ? changedSince(a && a.approved_tc_hashes, fp.tc_hashes) : [];
  let reason;
  if (!a) reason = 'not yet reviewed';
  else if (a.status === 'PENDING') reason = `awaiting review since ${a.requested_at.slice(0, 16).replace('T', ' ')}`;
  else if (a.status === 'CHANGES_REQUESTED') reason = `changes requested by ${a.by}: ${a.note}`;
  else if (a.status === 'DECLINED') reason = `declined by ${since(a)}${a.note ? `: ${a.note}` : ''} - not filed`;
  else reason = `content changed after ${a.by} approved${a.version ? ` v${a.version}` : ''} - needs re-approval`;
  return { ok: false, reason, status: a ? a.status : 'NOT_REQUESTED', file: fp.file, changed, declined: Boolean(a && a.status === 'DECLINED') };
}

function entry(record, gate) {
  record.approvals = record.approvals || {};
  record.approvals[gate] = record.approvals[gate] || { status: null, rounds: 0, log: [] };
  return record.approvals[gate];
}

function log(a, event, detail) {
  a.log = [...(a.log || []), { at: nowIso(), event, ...detail }].slice(-LOG_CAP);
}

function request(cwd, config, state, id, gate) {
  const fp = fingerprint(cwd, config, state, id, gate);
  if (!fp.applicable) return { skipped: true, reason: fp.reason };
  if (fp.missing) throw new UsageError(fp.missing);
  const record = holder(state, id, gate, { create: true });
  if (!record) throw new UsageError(`No state record for ${id} - record a stage first.`);
  const a = entry(record, gate);
  const prevApproved = a.approved_tc_hashes || null;
  if (a.status !== 'PENDING' || a.hash !== fp.hash) a.rounds = (a.rounds || 0) + 1;
  Object.assign(a, { status: 'PENDING', hash: fp.hash, version: fp.version, file: fp.file, requested_at: nowIso() });
  log(a, 'REQUESTED', { ...(fp.version ? { version: fp.version } : {}), round: a.rounds });
  const changed = gate === 'test-cases' ? changedSince(prevApproved, fp.tc_hashes) : [];
  return { skipped: false, file: fp.file, version: fp.version, round: a.rounds, changed, first_review: !prevApproved };
}

/**
 * The reviewer's name: --by, else SDET_RUNNER_ID / git user.email matched in authors.json
 * (the same registry record-run.js uses). Never guessed.
 */
function resolveReviewer(cwd, by) {
  if (typeof by === 'string' && by.trim()) return by.trim();
  const registry =
    readJson(path.join(cwd, '.claude', 'config', 'authors.json'), null) ||
    readJson(path.join(__dirname, '..', '..', 'config', 'authors.json'), null) ||
    { authorities: [] };
  const people = registry.authorities || [];
  const envId = process.env.SDET_RUNNER_ID;
  let person = envId && people.find((p) => p.id === envId);
  if (!person) {
    let email = '';
    try {
      email = execSync('git config user.email', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      /* not a git checkout, or no git */
    }
    person = email && people.find((p) => String(p.email).toLowerCase() === email.toLowerCase());
  }
  if (!person) throw new UsageError('Could not tell who the reviewer is - pass --by "<name>".');
  return person.name;
}

/**
 * Record the reviewer's decision. `reject` means "changes requested" for a spec / test cases (the
 * pipeline fixes and re-asks, so the reason is required) and "declined - do not file" for a bug.
 */
function decide(cwd, config, state, id, gate, { decision, by, note }) {
  const fp = fingerprint(cwd, config, state, id, gate);
  if (!fp.applicable) throw new UsageError(`${id}: ${fp.reason}.`);
  if (fp.missing) throw new UsageError(fp.missing);
  const record = holder(state, id, gate, { create: true });
  if (!record) throw new UsageError(`No state record for ${id}.`);
  const reviewer = resolveReviewer(cwd, by);
  const a = entry(record, gate);
  const text = note && note !== true && String(note).trim() ? String(note).trim() : null;
  if (decision === 'REJECTED') {
    if (gate === 'bug') {
      Object.assign(a, { status: 'DECLINED', by: reviewer, at: nowIso(), note: text, hash: fp.hash, file: fp.file });
      log(a, 'DECLINED', { by: reviewer, ...(text ? { note: text } : {}) });
      return { reviewer, file: fp.file, status: 'DECLINED' };
    }
    if (!text) throw new UsageError('--note is required: record why it was disapproved and what has to change.');
    Object.assign(a, { status: 'CHANGES_REQUESTED', by: reviewer, at: nowIso(), note: text });
    log(a, 'CHANGES_REQUESTED', { by: reviewer, version: fp.version, note: text });
    return { reviewer, file: fp.file, status: 'CHANGES_REQUESTED' };
  }
  // Approving pins exactly what is on disk now - if it changed since the request, the reviewer
  // must have seen the new content (the skill re-shows it), so the current fingerprint is what counts.
  Object.assign(a, {
    status: 'APPROVED',
    by: reviewer,
    at: nowIso(),
    note: text,
    hash: fp.hash,
    version: fp.version,
    file: fp.file,
    ...(fp.tc_hashes ? { approved_tc_hashes: fp.tc_hashes } : {}),
  });
  log(a, 'APPROVED', { by: reviewer, ...(fp.version ? { version: fp.version } : {}), ...(text ? { note: text } : {}) });
  if (gate === 'test-cases') stampDocument(cwd, config, record, id, reviewer);
  return { reviewer, file: fp.file, status: 'APPROVED' };
}

/** Record the approval in the document itself (release history + document control), then re-render. */
function stampDocument(cwd, config, record, id, reviewer) {
  const { file, doc } = tcs.loadDoc(cwd, config, id, record);
  const date = today();
  const version = doc.meta.version;
  const row = (doc.release_history || []).find((r) => String(r.version) === String(version));
  if (row) {
    for (const [k, v] of [['reviewed_by', reviewer], ['reviewed_on', date], ['approved_by', reviewer], ['approved_on', date]]) {
      if (!row[k] || TBD_RE.test(String(row[k]))) row[k] = v;
    }
  }
  if (doc.document_control) doc.document_control.approved_date = date;
  tcs.writeDoc(file, doc);
  tcs.writeMarkdown(file, doc, { config, cwd });
}

function status(cwd, config, state, id) {
  const gates = BUG_ID_RE.test(id) ? ['bug'] : SPEC_GATES;
  return Object.fromEntries(
    gates.map((gate) => {
      const c = check(cwd, config, state, id, gate);
      const a = ((holder(state, id, gate) || {}).approvals || {})[gate] || null;
      return [gate, { ...c, rounds: a ? a.rounds : 0, log: a ? a.log : [] }];
    })
  );
}

module.exports = { GATES, SPEC_GATES, BUG_ID_RE, requireGate, gateEnabled, check, request, decide, status, isGeneratedSpec };
