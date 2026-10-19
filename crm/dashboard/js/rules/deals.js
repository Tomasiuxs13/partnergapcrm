// Deal groups and totals (Appendix B.5). Pure; takes {meta, today}. G0 stub; owner F4.

export function dealGroups(records, { meta, today } = {}) {
  return { negotiating: [], signed: [], live: [], lost: [], totals: { negotiating: 0, signed: 0 } };
}
