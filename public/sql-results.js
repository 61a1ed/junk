// A result table knows only columns, values, and an optional cell decorator.
// Decorators return a disposer, or nothing to keep the ordinary text cell.
export function renderSqlResults(container, result, decorateCell = () => {}) {
  const disposers = [];
  const table = document.createElement('table');
  table.className = 'data-table';
  const header = table.createTHead().insertRow();
  for (const name of result.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    header.append(th);
  }
  const body = table.createTBody();
  for (const values of result.rows) {
    const row = body.insertRow();
    values.forEach((value, index) => {
      const cell = row.insertCell();
      cell.className = 'monospace';
      const text = document.createElement('span');
      text.className = value === null ? 'cell-truncate small-muted' : 'cell-truncate';
      text.textContent = value === null ? 'NULL' : String(value);
      text.title = value === null ? '' : String(value);
      cell.append(text);
      const dispose = decorateCell({ container: cell, column: result.columns[index], value });
      if (dispose) disposers.push(dispose);
    });
  }
  container.replaceChildren();
  if (result.columns.length) container.append(table);
  if (!result.columns.length || !result.rows.length) {
    const empty = document.createElement('div');
    empty.className = 'simple-empty';
    empty.textContent = result.columns.length ? 'Query completed. No rows matched.' : 'Query returned no columns.';
    container.append(empty);
  }
  return () => { for (const dispose of disposers.splice(0)) dispose(); };
}
