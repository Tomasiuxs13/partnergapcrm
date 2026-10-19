// Record panel entry points (spec 4.2, 5.4). Only the router opens or closes the panel.
// G0 stub; owner G1-C (basic panel), then F1.

export function openRecord(id, { queue, focus } = {}) {}

export async function closeRecord({ force = false } = {}) {
  return true;
}

export function currentRecordId() {
  return null;
}

export function isDirty() {
  return false;
}
