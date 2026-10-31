import { DatabaseSync, constants } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

// A separate process is deliberate: terminating a JavaScript Worker cannot
// interrupt a synchronous native SQLite query. The server can kill this process.
process.once('message', ({ snapshot, sql }) => {
const db = new DatabaseSync(':memory:', { allowExtension: false });
try {
  db.deserialize(snapshot);
  db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
  // Only reads, scalar functions, and recursive SELECTs are useful in this console.
  // The authorizer also blocks ATTACH, PRAGMA changes, and writes hidden in WITH.
  const allowed = new Set([
    constants.SQLITE_READ, constants.SQLITE_SELECT,
    constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE,
  ]);
  db.setAuthorizer(action => allowed.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY);
  const started = performance.now();
  const statement = db.prepare(sql);
  const tail = sql.slice(statement.sourceSQL.length);
  if (!/^(?:\s|;|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*$/.test(tail)) throw new Error('Run one SQL statement at a time');
  statement.setReturnArrays(true);
  statement.setReadBigInts(true);
  const columns = statement.columns().map(column => column.name);
  if (!columns.length) throw new Error('Only read-only queries returning rows are supported');
  const rows = [];
  let truncated = false;
  let resultSize = 0;
  for (const row of statement.iterate()) {
    if (rows.length >= 500 || resultSize >= 2 * 1024 * 1024) { truncated = true; break; }
    const safeRow = row.map(value => {
      if (value instanceof Uint8Array) return `[BLOB · ${value.byteLength} bytes]`;
      if (typeof value === 'bigint') return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER ? Number(value) : value.toString();
      if (typeof value === 'string' && value.length > 10000) return `${value.slice(0, 10000)}… [cell truncated]`;
      return value;
    });
    resultSize += JSON.stringify(safeRow).length;
    rows.push(safeRow);
  }
  process.send({ columns, rows, elapsedMs: Math.round((performance.now() - started) * 100) / 100, truncated });
} catch (error) {
  process.send({ error: error.message });
} finally {
  db.close();
}
});
