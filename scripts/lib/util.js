const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Write-then-rename so an interrupted run never leaves a half-written state file.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

// Project-relative, forward-slash path: stable across Windows/POSIX so state
// written on one machine compares equal on another.
function rel(cwd, p) {
  return path.relative(cwd, path.resolve(cwd, p)).split(path.sep).join('/');
}

function normalizeText(text) {
  return String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function today() {
  return nowIso().slice(0, 10);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const push = (key, value) => {
      if (key in flags) flags[key] = [].concat(flags[key], value);
      else flags[key] = value;
    };
    if (eq !== -1) {
      push(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) push(key, true);
    else {
      push(key, next);
      i++;
    }
  }
  return { positional, flags };
}

function list(value) {
  if (value === undefined || value === null || value === true || value === false) return [];
  return []
    .concat(value)
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class UsageError extends Error {}

module.exports = {
  readJson,
  writeJson,
  writeText,
  rel,
  normalizeText,
  sha256,
  nowIso,
  today,
  parseArgs,
  list,
  stripAnsi,
  escapeRegex,
  UsageError,
};
