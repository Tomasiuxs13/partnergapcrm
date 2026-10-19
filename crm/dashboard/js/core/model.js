// Record derivation (spec 5.4, Appendix B definitions). Pure. G0 stub; owner G1-A.
// Record = v2 columns (6.3.2) + derived: cl, ck, label, drb, isNew, isPlatform, notContacted, closed,
//   lastActivity, quietDays, replyDate, replySource, waitingOnClient, nextText, due, q

export function derive(raw, { meta, today } = {}) {
  const r = Object.assign({}, raw || {});
  return Object.assign(r, {
    cl: [],
    ck: [],
    label: r.label || r.name || r.domain || "",
    drb: "",
    isNew: false,
    isPlatform: false,
    notContacted: false,
    closed: false,
    lastActivity: null,
    quietDays: null,
    replyDate: null,
    replySource: null,
    waitingOnClient: false,
    nextText: r.next_step || "",
    due: r.next_due || null,
    q: "",
  });
}

export function setWaitingOnClient(nextStep, on) {
  return String(nextStep == null ? "" : nextStep);
}

export function parseNext(nextStep) {
  return { waitingOnClient: false, text: String(nextStep == null ? "" : nextStep) };
}
