// Tiny in-page event bus. Owner G1-A. No side effects at import time.
// Events in use: "me" (name changed), "meta" (meta re-read), "api:writes" (writes in flight),
// "store:status" (store loading/error state), "unauthorized" (about to go to sign-in; save drafts),
// "queue" ({dir: 1|-1} from J/K; the record panel moves through its queue).
const handlers = new Map();

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => off(type, fn);
}

export function off(type, fn) {
  const set = handlers.get(type);
  if (set) set.delete(fn);
}

// A failing handler is reported and never stops the others.
export function emit(type, detail) {
  const set = handlers.get(type);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(detail);
    } catch (e) {
      if (typeof console !== "undefined") console.error(e);
    }
  }
}
