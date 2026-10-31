/* A query reads a disposable copy. The live SQLite worker is never exposed. */
importScripts('/vendor/sql-wasm.js');

const ready = initSqlJs({ locateFile: file => `/vendor/${file}` });
ready.catch(() => {});

// Inspect statement boundaries without treating quoted/commented semicolons as SQL.
function validateQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 20000) throw new Error('Enter a SQL query of at most 20,000 characters.');
  const tokens = [];
  let ended = false;
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (/\s/.test(char)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated SQL comment.');
      i = end + 2;
      continue;
    }
    if (char === ';') { ended = true; i++; continue; }
    if (ended) throw new Error('Run one SQL statement at a time.');
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const endChar = char === '[' ? ']' : char;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === endChar) {
          if (char !== '[' && sql[i + 1] === endChar) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw new Error('Unterminated quoted SQL value.');
      tokens.push('QUOTED');
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (word) { tokens.push(word[0].toUpperCase()); i += word[0].length; }
    else { tokens.push(char); i++; }
  }
  let first = 0;
  if (tokens[first] === 'EXPLAIN') {
    first++;
    if (tokens[first] === 'QUERY' && tokens[first + 1] === 'PLAN') first += 2;
  }
  if (!['SELECT', 'WITH'].includes(tokens[first])) throw new Error('Only read-only SELECT, WITH, or EXPLAIN queries are supported.');
}

self.onmessage = async ({ data }) => {
  let db, statement;
  try {
    const { snapshot, sql } = data || {};
    validateQuery(sql);
    if (!(snapshot instanceof Uint8Array)) throw new Error('A database snapshot is required.');
    const SQL = await ready;
    db = new SQL.Database(snapshot);
    // The allowlist blocks ATTACH and PRAGMA; query_only also blocks writes in WITH.
    db.run('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
    const started = performance.now();
    statement = db.prepare(sql);
    const columns = statement.getColumnNames();
    if (!columns.length) throw new Error('Only read-only queries returning rows are supported.');
    const rows = [];
    let truncated = false;
    let resultSize = 0;
    while (statement.step()) {
      if (rows.length >= 500) { truncated = true; break; }
      const row = statement.get(null, { useBigInt: true }).map(value => {
        if (value instanceof Uint8Array) return `[BLOB · ${value.byteLength} bytes]`;
        if (typeof value === 'bigint') return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER ? Number(value) : value.toString();
        if (typeof value === 'string' && value.length > 10000) return `${value.slice(0, 10000)}… [cell truncated]`;
        return value;
      });
      const rowSize = new TextEncoder().encode(JSON.stringify(row)).byteLength;
      if (resultSize + rowSize > 2 * 1024 * 1024) { truncated = true; break; }
      rows.push(row);
      resultSize += rowSize;
    }
    self.postMessage({ columns, rows, elapsedMs: Math.round((performance.now() - started) * 100) / 100, truncated });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  } finally {
    statement?.free();
    db?.close();
  }
};
