// Tiny in-page event bus. G0 stub; owner G1-A. The API below is a placeholder that G1-A may change.

const handlers = new Map();

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}

export function emit(type, detail) {
  const set = handlers.get(type);
  if (set) for (const fn of Array.from(set)) fn(detail);
}
