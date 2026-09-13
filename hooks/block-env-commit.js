#!/usr/bin/env node
/**
 * PreToolUse hook (Bash): blocks any git command that would stage or commit a
 * real .env file that isn't covered by .gitignore, enforcing the "never commit
 * real secrets" rule at the tool layer.
 *
 * Reads the Claude Code hook JSON payload from stdin. Exit 2 + stderr blocks the
 * command; exit 0 allows it.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const { tool_name, tool_input = {}, cwd } = payload;
  if (tool_name !== 'Bash') process.exit(0);

  const command = tool_input.command || '';
  const workDir = cwd || process.cwd();

  if (!fs.existsSync(path.join(workDir, '.git'))) process.exit(0); // not a git repo yet
  const envPath = path.join(workDir, '.env');
  if (!fs.existsSync(envPath)) process.exit(0); // nothing to leak

  const touchesEnvExplicitly = /(^|[\s"'])\.env(\s|["']|$)/.test(command) && !/\.env\.example/.test(command);
  const touchesEverything =
    /git\s+add\s+(-A|--all|\.)(\s|$)/.test(command) || /git\s+commit\s+(-a|--all)(\s|$)/.test(command);

  if (!touchesEnvExplicitly && !touchesEverything) process.exit(0);

  let ignored = false;
  try {
    execSync('git check-ignore -q .env', { cwd: workDir });
    ignored = true; // exit 0 => path is ignored
  } catch {
    ignored = false; // exit 1 (or git error) => not ignored
  }

  if (!ignored) {
    console.error(
      [
        'Blocked: this command would stage/commit .env, which is not covered by .gitignore.',
        '.env is expected to hold real secrets and must never be committed.',
        'Add ".env" to .gitignore first, or explicitly exclude it from this command.',
      ].join('\n')
    );
    process.exit(2);
  }

  process.exit(0);
});
