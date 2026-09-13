#!/usr/bin/env node
/**
 * PreToolUse hook (Write|Edit): blocks writes that look like a hard-coded secret,
 * enforcing the test-writer / code-reviewer "never hard-code credentials" rule at
 * the tool layer instead of relying only on the agent's own judgement.
 *
 * Reads the Claude Code hook JSON payload from stdin. Exit 2 + stderr blocks the
 * tool call and feeds the message back to the agent; exit 0 allows it.
 */
const fs = require('fs');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0); // malformed payload - fail open, don't block the user's work
  }

  const { tool_name, tool_input = {} } = payload;
  if (!['Write', 'Edit'].includes(tool_name)) process.exit(0);

  const filePath = tool_input.file_path || '';

  // .env.example exists specifically to hold dummy placeholder values.
  if (/\.env\.example$/i.test(filePath)) process.exit(0);
  // The real .env file is meant to hold real secrets - that's fine, it's gitignored.
  if (/(^|[\\/])\.env$/i.test(filePath)) process.exit(0);

  const content = tool_name === 'Write' ? tool_input.content || '' : tool_input.new_string || '';

  const patterns = [
    { re: /password\s*[:=]\s*['"][^'"$]{3,}['"]/i, label: 'hard-coded password' },
    { re: /api[_-]?key\s*[:=]\s*['"][^'"$]{6,}['"]/i, label: 'hard-coded API key' },
    { re: /client[_-]?secret\s*[:=]\s*['"][^'"$]{6,}['"]/i, label: 'hard-coded client secret' },
    { re: /\btoken\s*[:=]\s*['"][^'"$]{10,}['"]/i, label: 'hard-coded token' },
    { re: /Authorization['"]?\s*[:=]\s*['"]\s*Bearer\s+[A-Za-z0-9\-_.]{10,}/i, label: 'hard-coded Authorization/Bearer header' },
    { re: /Cookie['"]?\s*[:=]\s*['"][^'"$]{10,}['"]/i, label: 'hard-coded Cookie header' },
  ];

  // Lines that reference env/config mechanisms instead of a literal are fine.
  const isEnvReference = (line) =>
    /process\.env\.|import\.meta\.env\.|dotenv|getEnv\(|config\(\)|config\./i.test(line);

  const hits = [];
  content.split('\n').forEach((line, i) => {
    if (isEnvReference(line)) return;
    for (const { re, label } of patterns) {
      if (re.test(line)) hits.push(`  line ${i + 1}: possible ${label} -> ${line.trim().slice(0, 120)}`);
    }
  });

  if (hits.length > 0) {
    console.error(
      [
        `Blocked write to ${filePath || '(unknown file)'}: content looks like a hard-coded secret.`,
        ...hits,
        '',
        "Use an environment variable (process.env.X) or the project's existing config/.env",
        'mechanism instead. If this is a false positive, rephrase the line so it does not match',
        'a literal secret pattern.',
      ].join('\n')
    );
    process.exit(2);
  }

  process.exit(0);
});
