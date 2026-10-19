// Queue mode (spec 4.2): "‹ 3 of 17 · Do now ›", J/K and always-advance. Owner F1.
// The queue lives in memory only, keyed by the rec id it belongs to, so a reload with rec opens the
// site without a queue. Steps share one ids array, so walking a long queue never copies it.
// queue = {ids, index, label, primary?}: primary is an optional outcome id the opener wants first
// (for example "followed_up" in Sites › Waiting for reply › No reply in 14+ days).
// No side effects at import time.
import { html, raw } from "../../core/dom.js";
import { num } from "../../core/format.js";

const MAX = 400;
const queues = new Map(); // id -> {ids, index, label, primary}
const ours = new WeakSet(); // ids arrays this module already copied

// Keeps the queue for this id. Returns the stored queue (or null when the queue is empty).
export function setQueue(id, queue) {
  const key = String(id);
  if (!queue || !Array.isArray(queue.ids) || !queue.ids.length) {
    queues.delete(key);
    return null;
  }
  let ids = queue.ids;
  if (!ours.has(ids)) {
    ids = ids.map(String);
    ours.add(ids);
  }
  let index = queue.index != null && isFinite(Number(queue.index)) ? Number(queue.index) : ids.indexOf(key);
  if (ids[index] !== key) index = ids.indexOf(key);
  if (index < 0) {
    queues.delete(key);
    return null;
  }
  const q = { ids, index, label: queue.label ? String(queue.label) : "", primary: queue.primary || null };
  queues.delete(key);
  queues.set(key, q);
  while (queues.size > MAX) queues.delete(queues.keys().next().value);
  return q;
}

export function getQueue(id) {
  return queues.get(String(id)) || null;
}

export function clearQueue(id) {
  queues.delete(String(id));
}

// The next (dir 1) or previous (dir -1) id in the queue that exists (exists(id) -> boolean), as
// {id, index}, or null at the end.
export function neighbour(q, dir, exists) {
  if (!q) return null;
  const step = dir < 0 ? -1 : 1;
  for (let i = q.index + step; i >= 0 && i < q.ids.length; i += step) {
    if (!exists || exists(q.ids[i])) return { id: q.ids[i], index: i };
  }
  return null;
}

// The queue as the argument openRecord() takes for a neighbour.
export function queueFor(q, index) {
  return { ids: q.ids, index, label: q.label, primary: q.primary };
}

export function queueHtml(q, exists) {
  if (!q) return html``;
  const n = q.ids.length;
  const prev = neighbour(q, -1, exists);
  const next = neighbour(q, 1, exists);
  return html`<div class="ui-queue rc-queue" role="group" aria-label="Queue"><button type="button" class="ui-x" data-pq="-1" aria-label="Previous site (K)"${prev ? "" : raw(" disabled")}>‹<span class="rc-pq-word" aria-hidden="true"> Previous</span></button><span class="ui-queue-text">${num(q.index + 1)} of ${num(n)}${q.label ? " · " + q.label : ""}</span><button type="button" class="ui-x" data-pq="1" aria-label="Next site (J)"${next ? "" : raw(" disabled")}><span class="rc-pq-word" aria-hidden="true">Next </span>›</button></div>`;
}
