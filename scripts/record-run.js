#!/usr/bin/env node
/**
 * Appends/overwrites the execution log at the CALLING PROJECT's root: .lastrun.json
 *
 * Called as the last step of a pipeline command (/automate, /automate-api,
 * /regression, /review-automation) once the run's outcome is known. Deliberately a plain
 * script rather than left to the agent to compose by hand: the timestamp,
 * authority lookup, and changed-file list must be exact, not guessed.
 *
 * This file ships inside the sdet-pipeline plugin (scripts/record-run.js) and is invoked
 * with the target project as the working directory, e.g.:
 *   node "${CLAUDE_PLUGIN_ROOT}/scripts/record-run.js" \
 *     --pipeline automate \
 *     --command "/automate TC-102 login with valid credentials" \
 *     --agents test-writer,code-reviewer \
 *     --status pass \
 *     --summary "TC-102 automated; regression 42/42 passed" \
 *     [--files-added a.ts,b.ts] [--files-modified c.ts] [--files-deleted d.ts] \
 *     [--lessons-recorded "automation-knowledge/failures/FL-004.md"] \
 *     [--bugs-new BUG-004] [--bugs-still-open BUG-002,BUG-003] \
 *     [--bugs-fixed BUG-001] [--bugs-regressed BUG-005] \
 *     [--out path/to/.lastrun.json] [--runner-config path/to/authors.json]
 *
 * Deliberately NOT __dirname-relative: __dirname is wherever the plugin happens to be
 * installed (e.g. ~/.claude/plugins/...), never the project being automated. Both the
 * output file and the git-status scan below are resolved against process.cwd() instead,
 * which the calling skill always sets to the target project's root.
 *
 * The --bugs-* flags carry bug-reporter's per-run classification (see
 * bugs/README.md §"Per-run refresh procedure", a directory at the repo root decoupled
 * from automation-knowledge/) into this run's record, so .lastrun.json shows what
 * changed in the bug list since the last run, not just today's snapshot. Omit all of
 * them on a run that didn't touch bugs/.
 *
 * Exits non-zero only on a usage error (missing --pipeline/--command). Every
 * other failure (no git repo, unresolvable authority, unreadable config)
 * degrades to a placeholder value rather than blocking the pipeline.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true; // boolean flag
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function csv(value) {
  if (!value || value === true) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function gitEmail(cwd) {
  try {
    return execSync('git config user.email', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function isGitRepo(cwd) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// git status --porcelain=v1 codes: first col = staged, second = unstaged.
// '??' untracked/added, 'A' added, 'M'/' M' modified, 'D'/' D' deleted, 'R' renamed.
function detectChangesFromGit(cwd) {
  const added = [];
  const modified = [];
  const deleted = [];
  try {
    const raw = execSync('git status --porcelain=v1', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (code.includes('R')) {
        const [, to] = file.split('->').map((s) => s.trim());
        modified.push(to || file);
      } else if (code.includes('D')) {
        deleted.push(file);
      } else if (code.includes('A') || code === '??') {
        added.push(file);
      } else if (code.includes('M')) {
        modified.push(file);
      }
    }
  } catch {
    // leave arrays empty; caller notes git wasn't usable
  }
  return { added, modified, deleted };
}

function resolveAuthority(config, cwd) {
  const authorities = (config && config.authorities) || [];
  const strategies = (config && config.resolution) || ['env:SDET_RUNNER_ID', 'git:user.email', 'default'];

  for (const strategy of strategies) {
    if (strategy.startsWith('env:')) {
      const value = process.env[strategy.slice(4)];
      if (value) {
        const match = authorities.find((a) => a.id === value);
        if (match) return { authority: match, resolvedVia: strategy };
      }
    } else if (strategy.startsWith('git:')) {
      const email = gitEmail(cwd);
      if (email) {
        const match = authorities.find((a) => a.gitEmail === email || a.email === email);
        if (match) return { authority: match, resolvedVia: strategy };
      }
    } else if (strategy === 'default' && config && config.default) {
      const match = authorities.find((a) => a.id === config.default);
      if (match) return { authority: match, resolvedVia: 'default' };
    }
  }
  return {
    authority: { id: 'unknown', name: 'Unknown runner', email: null, role: null },
    resolvedVia: 'unresolved',
  };
}

function formatIST(date) {
  // en-CA gives YYYY-MM-DD ordering; build "YYYY-MM-DD HH:mm:ss IST" ourselves
  // so the string sorts and reads predictably regardless of locale defaults.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} IST`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.pipeline || !args.command) {
    console.error('Usage: record-run.js --pipeline <automate|automate-api|regression|review-automation> --command "<text>" [options]');
    process.exit(1);
  }

  const cwd = process.cwd();
  const bundledConfigPath = path.join(__dirname, '..', 'config', 'authors.json');
  const projectConfigPath = path.join(cwd, '.claude', 'config', 'authors.json');
  // Resolution order: explicit --runner-config flag > the calling project's own
  // .claude/config/authors.json (lets a project override the plugin's bundled
  // default runner registry) > the plugin's bundled config as a fallback.
  const runnerConfigPath = args['runner-config']
    ? path.resolve(cwd, args['runner-config'])
    : fs.existsSync(projectConfigPath)
      ? projectConfigPath
      : bundledConfigPath;
  const outPath = args.out ? path.resolve(cwd, args.out) : path.join(cwd, '.lastrun.json');

  const config = readJson(runnerConfigPath);
  if (!config) {
    console.error(`Warning: could not read authority config at ${runnerConfigPath}; recording as unknown runner.`);
  }
  const { authority, resolvedVia } = resolveAuthority(config, cwd);

  let changes;
  const hasExplicitChanges = args['files-added'] || args['files-modified'] || args['files-deleted'];
  if (hasExplicitChanges) {
    changes = {
      filesAdded: csv(args['files-added']),
      filesModified: csv(args['files-modified']),
      filesDeleted: csv(args['files-deleted']),
      detectedVia: 'manual',
    };
  } else if (isGitRepo(cwd)) {
    const detected = detectChangesFromGit(cwd);
    changes = {
      filesAdded: detected.added,
      filesModified: detected.modified,
      filesDeleted: detected.deleted,
      detectedVia: 'git status --porcelain',
    };
  } else {
    changes = {
      filesAdded: [],
      filesModified: [],
      filesDeleted: [],
      detectedVia: 'none (not a git repository and no --files-* flags given)',
    };
  }

  const now = new Date();
  const record = {
    lastRun: {
      pipeline: args.pipeline,
      command: args.command,
      agents: csv(args.agents),
      runBy: {
        id: authority.id,
        name: authority.name,
        email: authority.email,
        role: authority.role,
        resolvedVia,
      },
      runAtIST: formatIST(now),
      runAtUTC: now.toISOString(),
      result: {
        status: args.status || 'unknown',
        summary: args.summary || '',
      },
      changes,
      lessonsRecorded: csv(args['lessons-recorded']),
      bugs: {
        new: csv(args['bugs-new']),
        stillOpen: csv(args['bugs-still-open']),
        fixed: csv(args['bugs-fixed']),
        regressed: csv(args['bugs-regressed']),
      },
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log(`Recorded run to ${outPath}`);
  console.log(JSON.stringify(record, null, 2));
}

main();
