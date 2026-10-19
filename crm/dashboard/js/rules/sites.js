// Sites rules (Appendix B.4): tab predicates, quiet=14, presets, clean-up counts.
// Pure; takes {meta, today, me}. G0 stub; owner F3.

export function tabs(records, { meta, me } = {}) {
  return { mine: [], unowned: [], waiting: [], all: [] };
}

export function noReply(records, { meta, today } = {}) { return []; }

export const presets = {};

export function cleanupCounts(records, { meta, today } = {}) { return {}; }
