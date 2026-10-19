// The only UI write path for site fields (spec 4.4, 4.5, 5.4). G0 stub; owner G1-C.

export async function update(id, fields, { label, undo = true } = {}) { return null; }

export async function outcome(id, outcomeId, opts = {}) { return null; }

export async function followUp(idOrIds, iso) {}

export async function claim(id) { return null; }

export async function bulk(ids, fields, { confirm = true, onlyIfEmpty } = {}) {
  return { changed: 0, failed: [], async undo() {} };
}

export function logMenu(anchorEl, record, { onDone } = {}) {}

export function followUpMenu(anchorEl, recordOrIds, { onDone } = {}) {}
