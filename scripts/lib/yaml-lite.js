/**
 * Minimal, dependency-free YAML reader for specification files and frontmatter.
 *
 * The plugin ships no node_modules, so this deliberately covers only the subset
 * a testing spec realistically uses: nested maps and sequences by indentation,
 * `key: value` scalars (quoted or plain), `- item` sequences (including
 * `- key: value` map items), flow sequences (`[a, b]`), and `|` / `>` block
 * scalars. Anchors, tags, multi-document streams and flow maps are not
 * supported. If the calling project has `yaml` or `js-yaml` installed, that
 * full parser is preferred automatically (see parseYaml below).
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function scalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^(null|~)$/i.test(s)) return null;
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map(scalar);
  }
  return s;
}

function splitFlow(text) {
  const parts = [];
  let quote = null;
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Splits "key: value" at the first colon that is outside quotes and followed by
// whitespace or end of line. Returns null when the content isn't a key.
function splitKey(content) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && i === 0) {
      quote = ch;
    } else if (ch === ':' && (i === content.length - 1 || /\s/.test(content[i + 1]))) {
      return { key: String(scalar(content.slice(0, i))), value: content.slice(i + 1).trim() };
    }
  }
  return null;
}

const isSeqItem = (content) => content === '-' || content.startsWith('- ');

function parseYamlLite(text) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      const indent = raw.match(/^ */)[0].length;
      const content = stripComment(raw.trim());
      return { raw, indent, content };
    });
  const ctx = { i: 0 };
  const blank = (l) => !l.content || l.content === '---' || l.content === '...';

  function skipBlank() {
    while (ctx.i < lines.length && blank(lines[ctx.i])) ctx.i++;
  }

  function parseNode(minIndent) {
    skipBlank();
    if (ctx.i >= lines.length) return null;
    const line = lines[ctx.i];
    if (line.indent < minIndent) return null;
    return isSeqItem(line.content) ? parseSeq(line.indent) : parseMap(line.indent);
  }

  function blockScalar(style, keyIndent) {
    const collected = [];
    let blockIndent = null;
    while (ctx.i < lines.length) {
      const { raw, indent } = lines[ctx.i];
      if (raw.trim() === '') {
        collected.push('');
        ctx.i++;
        continue;
      }
      if (indent <= keyIndent) break;
      if (blockIndent === null) blockIndent = indent;
      collected.push(raw.slice(Math.min(blockIndent, indent)));
      ctx.i++;
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    if (style.startsWith('|')) return collected.join('\n');
    return collected
      .join('\n')
      .split(/\n{2,}/)
      .map((para) => para.replace(/\n/g, ' ').trim())
      .join('\n');
  }

  function valueFor(value, keyIndent) {
    if (value === '') {
      skipBlank();
      if (ctx.i >= lines.length) return null;
      const next = lines[ctx.i];
      if (next.indent > keyIndent) return parseNode(next.indent);
      if (next.indent === keyIndent && isSeqItem(next.content)) return parseSeq(keyIndent);
      return null;
    }
    if (/^[|>][+-]?$/.test(value)) return blockScalar(value, keyIndent);
    return scalar(value);
  }

  function parseMap(indent) {
    const obj = {};
    while (true) {
      skipBlank();
      if (ctx.i >= lines.length) break;
      const line = lines[ctx.i];
      if (line.indent !== indent || isSeqItem(line.content)) break;
      const kv = splitKey(line.content);
      if (!kv) break;
      ctx.i++;
      obj[kv.key] = valueFor(kv.value, indent);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (true) {
      skipBlank();
      if (ctx.i >= lines.length) break;
      const line = lines[ctx.i];
      if (line.indent !== indent || !isSeqItem(line.content)) break;
      const rest = line.content === '-' ? '' : line.content.slice(2).trim();
      ctx.i++;
      if (rest === '') {
        arr.push(parseNode(indent + 1));
        continue;
      }
      const kv = /^["'[{]/.test(rest) ? null : splitKey(rest);
      if (!kv) {
        arr.push(scalar(rest));
        continue;
      }
      // "- key: value" starts a map item; its siblings sit at the column of "key".
      const itemIndent = indent + 2;
      const obj = { [kv.key]: valueFor(kv.value, itemIndent) };
      skipBlank();
      if (ctx.i < lines.length && lines[ctx.i].indent > indent && !isSeqItem(lines[ctx.i].content)) {
        Object.assign(obj, parseMap(lines[ctx.i].indent));
      }
      arr.push(obj);
    }
    return arr;
  }

  const result = parseNode(0);
  return result === null ? {} : result;
}

function parseYaml(text, cwd = process.cwd()) {
  for (const lib of ['yaml', 'js-yaml']) {
    try {
      const mod = require(require.resolve(lib, { paths: [cwd] }));
      return lib === 'yaml' ? mod.parse(text) : mod.load(text);
    } catch {
      // not installed in the calling project (or failed to parse) - fall through
    }
  }
  return parseYamlLite(text);
}

module.exports = { parseYaml, parseYamlLite };
