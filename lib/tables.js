// Does a D1 table exist? (spec 6.2). Positive answers are cached per isolate; a missing table is checked
// again on every call (one tiny sqlite_master query), so a migration applied after the deploy takes
// effect at once. Features that need 003/004 tables return null or hide until then; nothing fails.

const seen = new Set();

/** True when the table exists. Only positive answers are cached. */
export async function hasTable(db, name) {
  return (await hasTables(db, [name]))[name];
}

/** {name: boolean} for several tables, with at most one query (none when every name is cached). */
export async function hasTables(db, names) {
  const out = {};
  const ask = [];
  for (const n of names) {
    out[n] = seen.has(n);
    if (!out[n]) ask.push(n);
  }
  if (!ask.length || !db) return out;
  const marks = ask.map((_, i) => "?" + (i + 1)).join(", ");
  const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${marks})`).bind(...ask).all();
  for (const r of results || []) {
    seen.add(r.name);
    out[r.name] = true;
  }
  return out;
}

/** Forgets the cached answers (tests only). */
export function resetTables() {
  seen.clear();
}
