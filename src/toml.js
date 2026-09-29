/**
 * Minimal TOML subset parser — enough for Harbor/deep-swe task.toml files.
 *
 * Supported: [table], [[array-of-table]], bare/quoted keys, basic strings
 * ("..." with escapes), literal strings ('...'), integers, floats, booleans,
 * single-line arrays of scalars, comments, blank lines. Everything deep-swe
 * task.toml files use (validated against all 113 tasks in the corpus).
 *
 * Deliberately NOT supported: multi-line strings, inline tables, dotted keys,
 * dates, heterogeneous nesting beyond the above. A task file using them
 * throws with the offending line — fail loud, never silently mis-parse an
 * eval task definition.
 */

/** @returns {Record<string, unknown>} */
export function parseToml(text) {
  const root = {};
  /** Current table reference. */
  let table = root;
  /** Path of the current table (for [[array]] appends). */
  let tablePath = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (line.startsWith("[[")) {
      const m = line.match(/^\[\[\s*(.+?)\s*\]\]$/);
      if (!m) throw err("malformed [[array-of-table]] header", i, raw);
      const path = splitKey(m[1]);
      table = pushArrayTable(root, path);
      tablePath = path;
      continue;
    }
    if (line.startsWith("[")) {
      const m = line.match(/^\[\s*(.+?)\s*\]$/);
      if (!m) throw err("malformed [table] header", i, raw);
      const path = splitKey(m[1]);
      table = ensureTable(root, path);
      tablePath = path;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) throw err("expected key = value", i, raw);
    const key = parseKey(line.slice(0, eq).trim(), i, raw);
    const value = parseValue(line.slice(eq + 1).trim(), i, raw);
    if (key in table) throw err(`duplicate key "${key}"`, i, raw);
    table[key] = value;
  }
  return root;
}

function stripComment(line) {
  // A '#' outside of strings starts a comment. Inside basic strings a
  // backslash escapes the next character (so \" does not close the string);
  // literal strings ('...') have no escapes.
  let inBasic = false;
  let inLiteral = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBasic) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inBasic = false;
    } else if (inLiteral) {
      if (c === "'") inLiteral = false;
    } else if (c === '"') {
      inBasic = true;
    } else if (c === "'") {
      inLiteral = true;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitKey(dotPath) {
  // "verifier.collect" → ["verifier", "collect"]; quoted segments respected.
  const out = [];
  let cur = "";
  let quoted = null;
  for (const c of dotPath) {
    if (quoted) {
      if (c === quoted) quoted = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quoted = c;
    } else if (c === ".") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.filter((p) => p.length > 0);
}

function parseKey(keyText, lineNo, raw) {
  if (keyText.startsWith('"') || keyText.startsWith("'")) return parseValue(keyText, lineNo, raw);
  if (!/^[A-Za-z0-9_-]+$/.test(keyText)) throw err(`invalid bare key "${keyText}"`, lineNo, raw);
  return keyText;
}

function parseValue(text, lineNo, raw) {
  if (text.startsWith("[")) return parseArray(text, lineNo, raw);
  if (text.startsWith('"')) return parseBasicString(text, lineNo, raw);
  if (text.startsWith("'")) {
    const m = text.match(/^'([^']*)'$/);
    if (!m) throw err("malformed literal string", lineNo, raw);
    return m[1];
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d+$/.test(text)) return parseInt(text, 10);
  if (/^[+-]?(\d+\.\d*|\d*\.\d+)([eE][+-]?\d+)?$/.test(text)) return parseFloat(text);
  throw err(`unsupported value syntax: ${text}`, lineNo, raw);
}

function parseArray(text, lineNo, raw) {
  const m = text.match(/^\[\s*(.*)\s*\]$/);
  if (!m) throw err("malformed array (multi-line arrays unsupported)", lineNo, raw);
  const inner = m[1].trim();
  if (!inner) return [];
  // Split on commas not inside strings.
  const parts = [];
  let cur = "";
  let inBasic = false;
  let inLiteral = false;
  for (const c of inner) {
    if (c === '"' && !inLiteral) inBasic = !inBasic;
    else if (c === "'" && !inBasic) inLiteral = !inLiteral;
    if (c === "," && !inBasic && !inLiteral) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts.map((p) => parseValue(p, lineNo, raw));
}

function parseBasicString(text, lineNo, raw) {
  const m = text.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (!m) throw err("malformed basic string", lineNo, raw);
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|["\\bfnrt])/g, (s, esc) => {
    if (esc.startsWith("u")) return String.fromCharCode(parseInt(esc.slice(1), 16));
    const map = { '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    return map[esc];
  });
}

function ensureTable(root, path) {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const last = i === path.length - 1;
    if (!(key in cur)) cur[key] = last ? {} : {};
    const next = cur[key];
    if (Array.isArray(next)) {
      // [[a.b]] then [a.b.c] — descend into the LAST array element.
      cur = next[next.length - 1];
    } else if (typeof next === "object" && next !== null) {
      cur = next;
    } else {
      throw new Error(`toml: table path conflicts with scalar: ${path.join(".")}`);
    }
  }
  return cur;
}

function pushArrayTable(root, path) {
  const parent = ensureTable(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!(key in parent)) parent[key] = [];
  const arr = parent[key];
  if (!Array.isArray(arr)) throw new Error(`toml: [[${path.join(".")}]] conflicts with a table`);
  const fresh = {};
  arr.push(fresh);
  return fresh;
}

function err(message, lineNo, raw) {
  return new Error(`toml line ${lineNo + 1}: ${message} — ${raw.trim().slice(0, 80)}`);
}
