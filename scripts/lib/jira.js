/**
 * Jira bookkeeping for the story-driven flow (/sdet --story <KEY>).
 *
 * The script never talks to Jira - all Jira reads and writes happen in the /sdet skill through the
 * Atlassian MCP connector. This module only records what the skill fetched or created, so that
 * everything downstream (spec versioning, bug de-duplication, the issue logs) is deterministic:
 *
 *   <stateDir>/jira/stories/<KEY>.json   the story as last fetched (snapshot, for change detection)
 *   <stateDir>/jira/bugs.json            registry: Jira bug <-> local BUG-NNN <-> story <-> test cases
 *   <jira spec folder>/<KEY>.md          the analysed spec; its frontmatter records jira_updated
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, rel, nowIso, normalizeText, UsageError } = require('./util');
const { stateDir } = require('./state');
const { jiraSpecFolder } = require('./config');
const specs = require('./specs');

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

function requireKey(key) {
  const k = String(key || '').trim().toUpperCase();
  if (!KEY_RE.test(k)) throw new UsageError(`"${key}" is not a Jira issue key (expected e.g. PROJ-123).`);
  return k;
}

function jiraDir(cwd, config) {
  return path.join(stateDir(cwd, config), 'jira');
}

function storyPath(cwd, config, key) {
  return path.join(jiraDir(cwd, config), 'stories', `${key}.json`);
}

function registryPath(cwd, config) {
  return path.join(jiraDir(cwd, config), 'bugs.json');
}

function issueUrl(config, key) {
  const site = config.jira && config.jira.siteUrl;
  return site ? `${String(site).replace(/\/+$/, '')}/browse/${key}` : null;
}

function loadStory(cwd, config, key) {
  return readJson(storyPath(cwd, config, key), null);
}

/** The spec file carrying this story: wherever a spec with id <KEY> already lives, else <jira spec folder>/<KEY>.md. */
function specFileFor(cwd, config, state, key) {
  const existing = specs.findSpecById(cwd, config, state, key);
  if (existing) return { file: path.resolve(cwd, existing.path), existing };
  return { file: path.resolve(cwd, jiraSpecFolder(config), `${key}.md`), existing: null };
}

function frontmatterOf(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    const m = text.match(/^﻿?---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = {};
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith('"')) {
        try {
          v = JSON.parse(v);
        } catch {
          v = v.slice(1, -1);
        }
      }
      fm[kv[1]] = v;
    }
    return fm;
  } catch {
    return {};
  }
}

/**
 * Record the story the skill fetched and say what the pipeline should do with it:
 *   NEW        no spec for this story yet -> analyse and stamp
 *   UPDATED    the story changed in Jira since its spec was written -> re-analyse and stamp (version bump)
 *   UNCHANGED  the spec already reflects this story version -> no re-analysis; process the existing spec
 */
function intake(cwd, config, state, key, story) {
  key = requireKey(key);
  if (!story || typeof story !== 'object') throw new UsageError('The story file is not valid JSON.');
  if (String(story.key || '').toUpperCase() !== key) throw new UsageError(`The story file is for ${story.key || '(no key)'}, not ${key}.`);
  for (const f of ['summary', 'updated']) if (!story[f]) throw new UsageError(`The story file is missing "${f}".`);
  const warnings = [];
  const project = key.split('-')[0];
  if (config.jira.projectKey && project !== config.jira.projectKey) {
    warnings.push(`${key} belongs to project ${project}, but jira.projectKey is ${config.jira.projectKey}.`);
  }
  const type = String(story.issuetype || '');
  if (type && !/story/i.test(type)) warnings.push(`${key} is a "${type}", not a Story - it is analysed the same way.`);
  if (!new RegExp(config.spec.idPattern).test(key)) warnings.push(`${key} does not match spec.idPattern ${config.spec.idPattern}.`);

  const record = { ...story, key, url: story.url || issueUrl(config, key), fetched_at: nowIso() };
  writeJson(storyPath(cwd, config, key), record);

  const { file, existing } = specFileFor(cwd, config, state, key);
  let classification = 'NEW';
  if (existing) {
    const fm = frontmatterOf(file);
    classification = fm.jira_updated && String(fm.jira_updated) === String(story.updated) ? 'UNCHANGED' : 'UPDATED';
  }
  return { key, classification, spec_path: rel(cwd, file), spec_version: existing ? existing.version : null, story_file: rel(cwd, storyPath(cwd, config, key)), warnings };
}

/**
 * Write the analysed spec: the skill's draft body under a script-owned frontmatter.
 * `revise` applies a reviewer's corrections to a spec that has not been processed yet: the file is
 * rewritten in place and keeps its version, so review rounds don't inflate the spec history.
 */
function stamp(cwd, config, state, key, draftFile, { force, revise } = {}) {
  key = requireKey(key);
  const story = loadStory(cwd, config, key);
  if (!story) throw new UsageError(`No story snapshot for ${key} - run "jira intake ${key} --file <story.json>" first.`);
  const draftPath = path.resolve(cwd, draftFile);
  if (!fs.existsSync(draftPath)) throw new UsageError(`Draft not found: ${draftFile}`);
  let body = normalizeText(fs.readFileSync(draftPath, 'utf8')).replace(/^---\n[\s\S]*?\n---\s*/, '');
  if (!/^#\s+\S/.test(body)) body = `# ${story.summary}\n\n${body}`;
  if (!/^##\s+Acceptance Criteria\s*$/im.test(body)) throw new UsageError('The draft needs an "## Acceptance Criteria" section (see templates/spec.jira.template.md).');
  if (!/^##\s+Open Questions\s*$/im.test(body)) throw new UsageError('The draft needs an "## Open Questions" section (write "- None" when the story is unambiguous).');

  const { file, existing } = specFileFor(cwd, config, state, key);
  let version = 1;
  if (existing && revise) {
    const record = state.specs[key];
    if (record && record.last_processed_hash === existing.hash) {
      throw new UsageError(`${rel(cwd, file)} v${existing.version} has already been processed - a correction now is a new version: stamp without --revise.`);
    }
    version = Number(existing.version) || 1;
  } else if (existing) {
    const fm = frontmatterOf(file);
    if (fm.jira_updated && String(fm.jira_updated) === String(story.updated) && !force) {
      throw new UsageError(`${rel(cwd, file)} already reflects the current version of ${key} - nothing to stamp (pass --force to rewrite it anyway).`);
    }
    version = (Number(existing.version) || 1) + 1;
  }
  const q = (v) => JSON.stringify(String(v));
  const fm = [
    '---',
    `id: ${key}`,
    `version: ${version}`,
    `name: ${q(story.summary)}`,
    'source: jira',
    `jira_key: ${key}`,
    ...(story.url ? [`jira_url: ${q(story.url)}`] : []),
    `jira_updated: ${q(story.updated)}`,
    '---',
  ].join('\n');
  writeText(file, `${fm}\n\n${body}\n`);
  return { key, path: rel(cwd, file), version, previous_version: existing ? existing.version : null };
}

// ---------------------------------------------------------------- bug registry

function loadRegistry(cwd, config) {
  const reg = readJson(registryPath(cwd, config), null) || { schemaVersion: 1, bugs: {} };
  reg.bugs = reg.bugs || {};
  return reg;
}

/** Put jira_key / jira_url into a local bug file's frontmatter (replacing any earlier value). */
function stampBugFile(file, jiraKey, url) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const m = text.match(/^(﻿?---\n)([\s\S]*?)(\n---)/);
  if (!m) return false;
  let lines = m[2].split('\n').filter((l) => !/^jira_(key|url):/.test(l));
  const at = Math.max(lines.findIndex((l) => /^bug_id:/.test(l)), 0) + 1;
  lines.splice(at, 0, `jira_key: ${jiraKey}`, ...(url ? [`jira_url: ${url}`] : []));
  fs.writeFileSync(file, m[1] + lines.join('\n') + m[3] + text.slice(m[0].length), 'utf8');
  return true;
}

/**
 * Record a Jira bug the skill created (or reused) for a genuine defect: which local bug it mirrors,
 * which story it is linked to and how, and which test cases found it.
 */
function linkBug(cwd, config, { jiraKey, bug, story, tcs, linkType, reused }) {
  jiraKey = requireKey(jiraKey);
  const reg = loadRegistry(cwd, config);
  const entry = reg.bugs[jiraKey] || { jira_key: jiraKey, created_at: nowIso(), test_cases: [], reuse_count: 0 };
  entry.url = issueUrl(config, jiraKey) || entry.url || null;
  if (story) entry.story = requireKey(story);
  if (linkType) {
    const allowed = config.jira.linkTypes || [];
    if (allowed.length && !allowed.some((t) => t.toLowerCase() === String(linkType).toLowerCase())) {
      throw new UsageError(`Link type "${linkType}" is not in jira.linkTypes (${allowed.join(', ')}).`);
    }
    entry.link_type = linkType;
  }
  entry.test_cases = [...new Set([...entry.test_cases, ...tcs])];
  if (reused) entry.reuse_count += 1;
  entry.updated_at = nowIso();
  if (bug) {
    const id = String(bug).toUpperCase();
    const file = path.resolve(cwd, config.paths.bugs || 'bugs', `${id}.md`);
    if (!fs.existsSync(file)) throw new UsageError(`No bug file at ${rel(cwd, file)} - bug-reporter files the local bug first.`);
    entry.local_bug = id;
    stampBugFile(file, jiraKey, entry.url);
  }
  reg.bugs[jiraKey] = entry;
  writeJson(registryPath(cwd, config), reg);
  return entry;
}

/** Jira bugs already recorded for a test case or a local bug - the first de-duplication check. */
function findBugs(cwd, config, { tc, bug, story }) {
  const reg = loadRegistry(cwd, config);
  return Object.values(reg.bugs).filter(
    (b) => (tc && b.test_cases.includes(tc)) || (bug && b.local_bug === String(bug).toUpperCase()) || (story && b.story === String(story).toUpperCase()),
  );
}

module.exports = { KEY_RE, requireKey, issueUrl, storyPath, loadStory, intake, stamp, loadRegistry, linkBug, findBugs, frontmatterOf };
