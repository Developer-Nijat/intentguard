export const nowIso = () => new Date().toISOString();

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Build an UPDATE from a patch using an allow-list that maps object fields to
 * columns. Returns false when the patch touches nothing.
 */
export function updateRow(q, table, id, patch, columns) {
  const sets = [];
  const params = [];
  for (const [field, spec] of Object.entries(columns)) {
    if (patch[field] === undefined) continue;
    const [column, encode] = Array.isArray(spec) ? spec : [spec, (v) => v];
    sets.push(`${column} = ?`);
    params.push(encode(patch[field]));
  }
  if (!sets.length) return false;
  q.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  return true;
}

export const asJson = (value) => (value === null || value === undefined ? null : JSON.stringify(value));
