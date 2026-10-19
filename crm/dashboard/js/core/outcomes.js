// Outcome catalogue (Appendix A) and the request builder for POST /api/partner/:id/outcome.
// Pure. G0 stub; owner G1-C.

export const OUTCOMES = [];

export function outcomesFor(record, { meta } = {}) {
  return { primary: [], more: [] };
}

export function buildOutcomeRequest(record, outcomeId, { note, reason, terms, link, followUp, me, meta, today } = {}) {
  return { fields: {}, activity: null };
}
