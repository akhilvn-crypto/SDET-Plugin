#!/usr/bin/env node
/**
 * Stop hook: makes sure the execution log actually gets written every time a
 * pipeline command runs, instead of relying on the agent to remember the last
 * step of /automate, /regression, or /review-automation.
 *
 * Logic (deliberately ordering-based, not timestamp-based - transcript order
 * is already chronological, so there's nothing to parse or trust a clock for):
 *   1. Find the LAST line in the transcript where the user *genuinely* invoked
 *      one of the four pipeline slash commands. Each transcript line is parsed
 *      as JSON and only counted when it's a real top-level command turn: the
 *      envelope's own `type` is "user", it carries no `toolUseResult` (that
 *      key only appears on a tool_result turn), and `message.content` is a
 *      plain string starting with "<command-name>/automate</command-name>"
 *      (etc). This deliberately does NOT do a raw substring/regex scan across
 *      the whole line - this hook's own source doubles as documentation (see
 *      the tag example right here in this comment), so a raw scan
 *      self-matches the moment this file is Read or Edited, or grepped, in a
 *      session - a real false-positive hit during development of this file.
 *   2. If none exists, there's nothing to enforce - exit 0.
 *   3. Scan from that line to the end of the transcript for a genuine Bash
 *      tool_use call whose command mentions record-run.js (same structural
 *      check: an assistant turn's tool_use input, not just the substring
 *      appearing anywhere, e.g. in a file dump).
 *   4. If found, the run was logged - exit 0. If not, block the stop (exit 2)
 *      so the agent finishes the job instead of ending the turn early.
 *
 * Only checked for the EXECUTION LOG, deliberately - whether a new
 * automation-knowledge/failures/FL-<NNN>.md entry was warranted is a judgement
 * call (not every run hits a failure worth logging), so it isn't safe to
 * hard-block on that the way this hook does for record-run.js.
 *
 * Fails open (exit 0) on anything ambiguous or unreadable: a missing/huge
 * transcript, a malformed payload, stop_hook_active already set (Claude Code
 * sets this on a repeat Stop within the same cycle - honoring it avoids an
 * infinite block/retry loop). This is a backstop, not a hard guarantee.
 */
const fs = require('fs');

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024; // skip enforcement on unreasonably large transcripts
// A plugin-provided command shows up in the transcript namespaced, e.g.
// "/sdet-pipeline:automate" rather than "/automate" — the optional
// "(?:[\w.-]+:)?" prefix matches either form so this works whether the pipeline
// is running from this plugin or from a plain project-level .claude/commands/.
const PIPELINE_COMMAND_RE = /^\s*<command-name>\s*\/(?:[\w.-]+:)?(automate-api|automate|regression|review-automation)\b/i;
const RECORD_RUN_RE = /record-run\.js/;

// True only for a real top-level user command turn, never a tool_result (or
// any other) turn that merely contains matching text somewhere inside it.
function genuinePipelineCommand(entry) {
  if (!entry || entry.type !== 'user') return null;
  if (Object.prototype.hasOwnProperty.call(entry, 'toolUseResult')) return null;
  const content = entry.message && entry.message.content;
  if (typeof content !== 'string') return null;
  const match = content.match(PIPELINE_COMMAND_RE);
  return match ? `/${match[1]}` : null;
}

// True only for a real Bash tool_use call, never a transcript line that
// merely mentions "record-run.js" (e.g. inside a Read/Edit file dump).
function genuineRecordRunCall(entry) {
  if (!entry || entry.type !== 'assistant') return false;
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      block &&
      block.type === 'tool_use' &&
      block.name === 'Bash' &&
      typeof block.input?.command === 'string' &&
      RECORD_RUN_RE.test(block.input.command)
  );
}

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0); // malformed payload - fail open
  }

  if (payload.stop_hook_active) process.exit(0); // avoid re-blocking in a loop

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  let lines;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) process.exit(0); // don't stall on a huge session
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    process.exit(0);
  }

  let lastPipelineIndex = -1;
  let lastPipelineCommand = null;
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // not parseable JSON - never a real command turn
    }
    const command = genuinePipelineCommand(entry);
    if (command) {
      lastPipelineIndex = i;
      lastPipelineCommand = command;
    }
  }

  if (lastPipelineIndex === -1) process.exit(0); // no pipeline command this transcript

  const afterPipeline = lines.slice(lastPipelineIndex + 1);
  const alreadyLogged = afterPipeline.some((line) => {
    try {
      return genuineRecordRunCall(JSON.parse(line));
    } catch {
      return false;
    }
  });

  if (alreadyLogged) process.exit(0);

  // CLAUDE_PLUGIN_ROOT is set by Claude Code whenever a plugin hook runs, so the
  // message below can point at the exact record-run.js this install actually uses
  // instead of guessing a path.
  const recordRunPath = process.env.CLAUDE_PLUGIN_ROOT
    ? `"${process.env.CLAUDE_PLUGIN_ROOT}/scripts/record-run.js"`
    : '<plugin>/scripts/record-run.js';

  console.error(
    [
      `Blocked stop: the last ${lastPipelineCommand} run has not recorded its execution log yet.`,
      `Before ending this turn, run node ${recordRunPath} as the final step of that command`,
      `(see the ${lastPipelineCommand.slice(1)} skill's SKILL.md, step 4, for the exact invocation -`,
      "remember MSYS_NO_PATHCONV=1 on Windows/Git Bash since --command starts with '/').",
    ].join('\n')
  );
  process.exit(2);
});
