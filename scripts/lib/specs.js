/**
 * Specification discovery, parsing, identity and change detection.
 *
 * A spec's identity is its stable `id` field - never its filename or folder.
 * Content comparison uses a hash of the normalised file text, so an unchanged
 * spec is recognised as unchanged no matter where it now lives.
 */
const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./yaml-lite');
const { rel, normalizeText, sha256, UsageError } = require('./util');

function isExcluded(name, relPath, exclude) {
  return exclude.some((pattern) => {
    const p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '');
    return name === p || relPath === p || relPath.startsWith(`${p}/`);
  });
}

function walk(cwd, dir, { recursive, extensions, exclude }, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relPath = rel(cwd, full);
    if (isExcluded(entry.name, relPath, exclude)) continue;
    if (entry.isDirectory()) {
      if (recursive) walk(cwd, full, { recursive, extensions, exclude }, out);
    } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/** Resolve which files to consider. Explicit --spec paths take precedence over configured roots. */
function findSpecFiles(cwd, config, explicit = []) {
  const opts = {
    recursive: config.spec.recursive !== false,
    extensions: (config.spec.extensions || []).map((e) => e.toLowerCase()),
    exclude: config.spec.exclude || [],
  };
  const files = [];
  if (explicit.length) {
    for (const p of explicit) {
      const full = path.resolve(cwd, p);
      if (!fs.existsSync(full)) throw new UsageError(`--spec path not found: ${p}`);
      // An explicitly named directory is always searched recursively.
      if (fs.statSync(full).isDirectory()) walk(cwd, full, { ...opts, recursive: true }, files);
      else files.push(full);
    }
    return { files: [...new Set(files)], mode: 'explicit' };
  }
  if (!config.spec.enabled) return { files: [], mode: 'disabled' };
  for (const root of config.spec.roots || []) {
    const full = path.resolve(cwd, root);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(cwd, full, opts, files);
  }
  return { files: [...new Set(files)], mode: 'discovered' };
}

function slugKey(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseMarkdown(text, cwd) {
  let data = {};
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (fm) {
    try {
      data = parseYaml(fm[1], cwd) || {};
    } catch {
      data = {};
    }
    body = text.slice(fm[0].length);
  }
  // Bullet lists under headings become named sections, e.g. "## Scenarios" -> sections.scenarios.
  const sections = {};
  let current = null;
  let title = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      if (!title && h[1].length === 1) title = h[2];
      current = slugKey(h[2]);
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (item && current) (sections[current] = sections[current] || []).push(item[1].replace(/^\[[ xX]\]\s*/, ''));
  }
  return { data, sections, title };
}

function parseSpecText(text, ext, cwd) {
  if (ext === '.json') {
    try {
      return { data: JSON.parse(text) || {}, sections: {}, title: null };
    } catch (e) {
      return { data: {}, sections: {}, title: null, parseError: `Invalid JSON: ${e.message}` };
    }
  }
  if (ext === '.yaml' || ext === '.yml') {
    try {
      const data = parseYaml(text, cwd);
      return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, sections: {}, title: null };
    } catch (e) {
      return { data: {}, sections: {}, title: null, parseError: `Invalid YAML: ${e.message}` };
    }
  }
  return parseMarkdown(text, cwd);
}

function itemText(item) {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') return String(item);
  const label = item.id || item.name || item.title;
  const desc = item.description || item.scenario || item.summary;
  if (label && desc) return `${label}: ${desc}`;
  return label || desc || JSON.stringify(item);
}

/**
 * The comparable "requirement items" of a spec: every list (scenarios,
 * security_checks, accessibility_checks, acceptance_criteria, markdown bullet
 * sections...) and every top-level scalar. Used for requirement-level deltas.
 */
function extractItems(parsed) {
  const lists = {};
  const scalars = {};
  for (const [k, v] of Object.entries(parsed.data || {})) {
    if (k === 'id' || k === 'version') continue;
    if (Array.isArray(v)) lists[k] = v.map(itemText).filter(Boolean);
    else if (v !== null && typeof v === 'object') scalars[k] = JSON.stringify(v);
    else scalars[k] = String(v);
  }
  for (const [k, v] of Object.entries(parsed.sections || {})) {
    lists[k] = (lists[k] || []).concat(v);
  }
  return { lists, scalars };
}

function readSpec(cwd, file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = normalizeText(raw);
  const ext = path.extname(file).toLowerCase();
  const parsed = parseSpecText(text, ext, cwd);
  const data = parsed.data || {};
  const id = data.id !== undefined && data.id !== null && data.id !== '' ? String(data.id).trim() : null;
  const versionRaw = data.version;
  return {
    path: rel(cwd, file),
    ext,
    id,
    version: versionRaw === undefined || versionRaw === null || versionRaw === '' ? null : String(versionRaw),
    name: data.name || data.title || parsed.title || path.basename(file, ext),
    hash: sha256(text),
    text,
    items: extractItems(parsed),
    parseError: parsed.parseError || null,
  };
}

function suggestId(spec, usedIds, state, idPattern) {
  // A spec previously tracked at this exact path (legacy record) keeps its identity.
  const byPath = Object.values(state.specs).find((r) => r.spec_path === spec.path);
  if (byPath) return { id: byPath.spec_id, reason: `previously tracked at ${spec.path}` };
  // A spec whose content matches a processed record whose file has vanished was moved.
  const byHash = Object.values(state.specs).find((r) => r.last_processed_hash === spec.hash);
  if (byHash) return { id: byHash.spec_id, reason: 'content matches a previously processed spec' };
  const base = path
    .basename(spec.path, spec.ext)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'SPEC';
  const safeBase = /^[A-Z]/.test(base) ? base : `SPEC-${base}`;
  let n = 1;
  let candidate;
  do {
    candidate = `${safeBase}-${String(n).padStart(3, '0')}`;
    n++;
  } while (usedIds.has(candidate) || state.specs[candidate]);
  const valid = new RegExp(idPattern).test(candidate);
  return { id: candidate, reason: valid ? 'derived from filename' : 'derived from filename (does not match spec.idPattern - pick another)' };
}

/**
 * Classify every spec file against persisted state. Read-only: nothing is
 * written here, so discovery can run any number of times with no side effects.
 */
function discover(cwd, config, state, explicit = []) {
  const { files, mode } = findSpecFiles(cwd, config, explicit);
  const idPattern = new RegExp(config.spec.idPattern);
  const specs = files.map((f) => readSpec(cwd, f));
  const byId = new Map();
  for (const s of specs) if (s.id) byId.set(s.id, [...(byId.get(s.id) || []), s]);
  const usedIds = new Set([...byId.keys()]);

  const results = specs.map((s) => {
    const out = { path: s.path, id: s.id, version: s.version, name: s.name, hash: s.hash, warnings: [] };
    if (s.parseError) return { ...out, classification: 'INVALID', reason: s.parseError };
    if (!s.id) {
      return { ...out, classification: 'MISSING_ID', suggestion: suggestId(s, usedIds, state, config.spec.idPattern) };
    }
    if (!idPattern.test(s.id)) out.warnings.push(`id "${s.id}" does not match spec.idPattern ${config.spec.idPattern}`);
    if (s.version === null) out.warnings.push('no "version" field - treated as version 1; add one so changes are traceable');
    if (byId.get(s.id).length > 1) {
      return {
        ...out,
        classification: 'DUPLICATE_ID',
        reason: `id also used by ${byId.get(s.id).filter((o) => o !== s).map((o) => o.path).join(', ')}`,
      };
    }
    const record = state.specs[s.id];
    if (!record || record.source === 'autonomous') {
      if (record && record.source === 'autonomous') out.warnings.push(`id collides with an autonomous record ${s.id}`);
      return { ...out, classification: 'NEW' };
    }
    if (!record.last_processed_hash) {
      return { ...out, classification: 'RESUME', reason: `started earlier but never completed (last stage: ${record.status})` };
    }
    const moved = record.spec_path !== s.path;
    const changed = record.last_processed_hash !== s.hash;
    const detail = {
      previous_path: moved ? record.spec_path : undefined,
      last_processed_version: record.last_processed_version,
    };
    if (changed) {
      const prev = Number(record.last_processed_version);
      const cur = Number(s.version || 1);
      if (!Number.isNaN(prev) && !Number.isNaN(cur) && cur <= prev) {
        out.warnings.push(`content changed but version was not bumped (still ${s.version || 1}; last processed ${record.last_processed_version})`);
      }
      return { ...out, ...detail, classification: 'CHANGED', moved };
    }
    if (moved) return { ...out, ...detail, classification: 'MOVED' };
    if (record.status !== 'AUTOMATED') {
      return { ...out, ...detail, classification: 'RESUME', reason: `unchanged, but last run ended at ${record.status}` };
    }
    return { ...out, ...detail, classification: 'UNCHANGED' };
  });

  // State records whose spec no longer appears anywhere we looked. Only meaningful
  // on a full discovery - an explicit --spec run deliberately looks at a subset.
  const missing =
    mode === 'discovered'
      ? Object.values(state.specs)
          .filter((r) => r.source !== 'autonomous' && !byId.has(r.spec_id))
          .map((r) => ({
            id: r.spec_id,
            path: r.spec_path,
            classification: 'MISSING',
            reason: fs.existsSync(path.resolve(cwd, r.spec_path))
              ? 'file still exists but no longer carries this id (id changed or removed?)'
              : 'spec file not found under the configured roots (deleted, or moved outside spec.roots)',
          }))
      : [];

  return { mode, roots: config.spec.roots, results, missing };
}

function findSpecById(cwd, config, state, id) {
  const record = state.specs[id];
  const candidates = [];
  if (record && record.spec_path && fs.existsSync(path.resolve(cwd, record.spec_path))) {
    const s = readSpec(cwd, path.resolve(cwd, record.spec_path));
    if (s.id === id) return s;
  }
  const { files } = findSpecFiles(cwd, config, []);
  for (const f of files) {
    const s = readSpec(cwd, f);
    if (s.id === id) candidates.push(s);
  }
  if (candidates.length > 1) throw new UsageError(`Spec id ${id} is used by several files: ${candidates.map((c) => c.path).join(', ')}`);
  return candidates[0] || null;
}

/** Safe id migration: writes `id` (and `version: 1` if absent) into the spec file itself. */
function assignId(cwd, config, state, file, id) {
  const full = path.resolve(cwd, file);
  if (!fs.existsSync(full)) throw new UsageError(`Spec file not found: ${file}`);
  if (!new RegExp(config.spec.idPattern).test(id)) throw new UsageError(`"${id}" does not match spec.idPattern ${config.spec.idPattern}`);
  const spec = readSpec(cwd, full);
  if (spec.id) throw new UsageError(`${spec.path} already has id ${spec.id} - ids are stable and are not reassigned.`);
  // Refuse anything that would create a second spec with an existing identity.
  const { files } = findSpecFiles(cwd, config, []);
  for (const f of files) {
    const other = readSpec(cwd, f);
    if (other.id === id && other.path !== spec.path) throw new UsageError(`id ${id} is already used by ${other.path}`);
  }
  const record = state.specs[id];
  if (record && record.spec_path && record.spec_path !== spec.path) {
    const recordFile = path.resolve(cwd, record.spec_path);
    if (fs.existsSync(recordFile) && readSpec(cwd, recordFile).id === id) {
      throw new UsageError(`id ${id} is tracked for ${record.spec_path}, which still exists`);
    }
  }

  const raw = fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
  const needsVersion = spec.version === null;
  let updated;
  if (spec.ext === '.json') {
    const data = JSON.parse(raw);
    updated = JSON.stringify({ id, ...(needsVersion ? { version: 1 } : {}), ...data }, null, 2) + '\n';
  } else if (spec.ext === '.yaml' || spec.ext === '.yml') {
    const header = `id: ${id}\n${needsVersion ? 'version: 1\n' : ''}`;
    updated = raw.startsWith('---\n') ? `---\n${header}${raw.slice(4)}` : header + raw;
  } else {
    const header = `id: ${id}\n${needsVersion ? 'version: 1\n' : ''}`;
    updated = /^---\n[\s\S]*?\n---/.test(raw) ? `---\n${header}${raw.slice(4)}` : `---\n${header}---\n\n${raw}`;
  }
  fs.writeFileSync(full, updated, 'utf8');
  return { path: spec.path, id, versionAdded: needsVersion, adoptedExistingRecord: Boolean(record) };
}

/** Line-level LCS diff; spec files are small, so the O(n*m) table is fine up to a cap. */
function lineDiff(a, b, cap = 3000) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > cap * cap) return null;
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  return out;
}

function itemDelta(prevItems, curItems) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const lists = {};
  const keys = new Set([...Object.keys(prevItems.lists || {}), ...Object.keys(curItems.lists || {})]);
  for (const k of keys) {
    const prev = prevItems.lists[k] || [];
    const cur = curItems.lists[k] || [];
    const prevSet = new Set(prev.map(norm));
    const curSet = new Set(cur.map(norm));
    const added = cur.filter((s) => !prevSet.has(norm(s)));
    const removed = prev.filter((s) => !curSet.has(norm(s)));
    const unchanged = cur.filter((s) => prevSet.has(norm(s)));
    if (added.length || removed.length || unchanged.length) lists[k] = { added, removed, unchanged };
  }
  const scalars = {};
  const skeys = new Set([...Object.keys(prevItems.scalars || {}), ...Object.keys(curItems.scalars || {})]);
  for (const k of skeys) {
    const before = (prevItems.scalars || {})[k];
    const after = (curItems.scalars || {})[k];
    if (before !== after) scalars[k] = { before: before ?? null, after: after ?? null };
  }
  return { lists, scalars };
}

module.exports = { discover, readSpec, findSpecFiles, findSpecById, assignId, lineDiff, itemDelta };
