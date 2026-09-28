/**
 * Centralised configuration for the spec/test-management layer.
 *
 * Precedence (highest first):
 *   1. Runtime overrides passed to a command (--accessibility=true, --set testing.security=false, --spec-root x)
 *   2. The project's own sdet.config.json at the project root (or the file SDET_CONFIG points at)
 *   3. The plugin's bundled config/sdet.config.default.json
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, UsageError } = require('./util');

const DEFAULTS_PATH = path.join(__dirname, '..', '..', 'config', 'sdet.config.default.json');
const PROJECT_CONFIG_NAME = 'sdet.config.json';

// Shorthand runtime flags -> dotted config keys.
const SHORTHAND = {
  ui: 'testing.ui',
  functional: 'testing.functional',
  security: 'testing.security',
  accessibility: 'testing.accessibility',
  api: 'testing.api',
  visual: 'testing.visual',
  collection: 'api.collection',
  'spec-root': 'spec.roots',
  'spec-enabled': 'spec.enabled',
};

const ON_UNCHANGED = ['skip', 'verify', 'run'];

function loadDefaults() {
  const defaults = readJson(DEFAULTS_PATH);
  if (!defaults) throw new Error(`Bundled defaults missing or unreadable: ${DEFAULTS_PATH}`);
  delete defaults.$comment;
  return defaults;
}

function projectConfigPath(cwd) {
  return process.env.SDET_CONFIG ? path.resolve(cwd, process.env.SDET_CONFIG) : path.join(cwd, PROJECT_CONFIG_NAME);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// Coerce a CLI string into the type the default for that key has.
function coerce(raw, template) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (Array.isArray(template)) {
    if (s.startsWith('[')) return JSON.parse(s);
    return s === '' ? [] : s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (typeof template === 'boolean') {
    if (/^(true|yes|on|1)$/i.test(s)) return true;
    if (/^(false|no|off|0)$/i.test(s)) return false;
    throw new UsageError(`Expected true/false, got "${raw}"`);
  }
  if (typeof template === 'number') {
    const n = Number(s);
    if (Number.isNaN(n)) throw new UsageError(`Expected a number, got "${raw}"`);
    return n;
  }
  if (s === 'null') return null;
  if (template === null || template === undefined) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

// Accept `spec.root: "x"` (single root, as in the design doc) as an alias of `spec.roots: ["x"]`.
function normalize(config) {
  if (config.spec && typeof config.spec.root === 'string') {
    config.spec.roots = [config.spec.root];
    delete config.spec.root;
  }
  return config;
}

/** Turn parsed CLI flags into a list of {key, value} overrides. */
function overridesFromFlags(flags, defaults) {
  const overrides = [];
  for (const [flag, dotted] of Object.entries(SHORTHAND)) {
    if (flags[flag] === undefined) continue;
    if (flags[flag] === true && flag === 'spec-root') throw new UsageError('--spec-root needs a directory, e.g. --spec-root requirements/specs');
    if (flags[flag] === true && flag === 'collection') throw new UsageError('--collection needs a file, e.g. --collection postman/orders.json');
    const value = flags[flag] === true ? 'true' : flags[flag];
    overrides.push({ key: dotted, value: coerce([].concat(value).join(','), getPath(defaults, dotted)) });
  }
  for (const pair of [].concat(flags.set || [])) {
    const eq = String(pair).indexOf('=');
    if (eq === -1) throw new UsageError(`--set expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq).trim();
    overrides.push({ key, value: coerce(pair.slice(eq + 1), getPath(defaults, key)) });
  }
  return overrides;
}

function loadConfig(cwd, flags = {}) {
  const defaults = loadDefaults();
  const file = projectConfigPath(cwd);
  const exists = fs.existsSync(file);
  let project = {};
  if (exists) {
    project = readJson(file);
    if (!project) throw new UsageError(`${file} is not valid JSON - fix it or re-create it with "/sdet-config init --force".`);
    delete project.$comment;
  }
  let config = normalize(deepMerge(defaults, normalize(project)));
  const overrides = overridesFromFlags(flags, defaults);
  for (const { key, value } of overrides) setPath(config, key, value);
  config = normalize(config);
  return {
    config,
    sources: {
      defaults: DEFAULTS_PATH,
      project: exists ? file : null,
      overrides: overrides.map((o) => `${o.key}=${JSON.stringify(o.value)}`),
    },
  };
}

function validateConfig(config, defaults = loadDefaults()) {
  const errors = [];
  const warnings = [];
  const walk = (obj, tmpl, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (k.startsWith('$')) continue;
      if (!(k in tmpl)) {
        warnings.push(`Unknown key "${key}" (ignored by the pipeline).`);
        continue;
      }
      const t = tmpl[k];
      if (isPlainObject(t)) {
        if (!isPlainObject(v)) errors.push(`"${key}" must be an object.`);
        else walk(v, t, key);
      } else if (Array.isArray(t) && !Array.isArray(v)) errors.push(`"${key}" must be an array.`);
      else if (typeof t === 'boolean' && typeof v !== 'boolean') errors.push(`"${key}" must be true or false.`);
      else if (typeof t === 'string' && typeof v !== 'string') errors.push(`"${key}" must be a string.`);
    }
  };
  walk(config, defaults, '');
  const spec = config.spec || {};
  if (Array.isArray(spec.roots) && spec.roots.length === 0 && spec.enabled) {
    warnings.push('spec.enabled is true but spec.roots is empty - only explicit --spec paths will be processed.');
  }
  for (const ext of spec.extensions || []) {
    if (!String(ext).startsWith('.')) errors.push(`spec.extensions entry "${ext}" must start with "." (e.g. ".md").`);
  }
  try {
    new RegExp(spec.idPattern);
  } catch {
    errors.push(`spec.idPattern "${spec.idPattern}" is not a valid regular expression.`);
  }
  if (!ON_UNCHANGED.includes(config.execution && config.execution.onUnchanged)) {
    errors.push(`execution.onUnchanged must be one of ${ON_UNCHANGED.join(', ')}.`);
  }
  const testing = config.testing || {};
  if (testing.functional === false && !testing.security && !testing.accessibility) {
    warnings.push('Every testing dimension is disabled - /sdet will have nothing to generate.');
  }
  if (!testing.ui && !testing.api && !testing.visual) {
    warnings.push('testing.ui, testing.api and testing.visual are all false - test cases will be generated but nothing will be automated.');
  }
  const collection = config.api && config.api.collection;
  if (collection != null && typeof collection !== 'string') errors.push('"api.collection" must be a file path or null.');
  else if (collection && !testing.api) warnings.push('api.collection is set but testing.api is false - the collection is ignored.');
  return { errors, warnings };
}

function writeProjectConfig(cwd, config) {
  const file = projectConfigPath(cwd);
  const out = {
    $comment:
      'Central settings for the sdet-pipeline spec/test-management layer (/sdet). Edit freely or use /sdet-config set <key> <value>. Keys you remove fall back to the plugin defaults. Runtime flags on /sdet (e.g. --accessibility=true, --spec <path>) override this file for a single run.',
    ...config,
  };
  writeJson(file, out);
  return file;
}

module.exports = {
  loadConfig,
  loadDefaults,
  overridesFromFlags,
  validateConfig,
  writeProjectConfig,
  projectConfigPath,
  getPath,
  setPath,
  coerce,
  deepMerge,
  normalize,
  PROJECT_CONFIG_NAME,
};
