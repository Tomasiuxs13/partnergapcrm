// The only module that calls fetch (spec 5.1, 5.4, 6.3.15). G0 stub; owner G1-A.
// Every call resolves to null, which callers treat as "Not available yet".

export class ApiError extends Error {
  constructor(status, friendly = "", data = null) {
    super(friendly || "Request failed (" + status + ")");
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.friendly = friendly;
  }
}

export async function request(method, url, body, { timeout = 15000, signal } = {}) {
  return null;
}

export const api = {
  async meta() { return null; },
  async partners({ etag } = {}) { return null; },
  async partnersByIds(ids) { return null; },
  async partner(id) { return null; },
  async about(id) { return null; },
  async aboutDomain(domain) { return null; },
  async update(id, fields) { return null; },
  async outcome(id, { fields, activity } = {}) { return null; },
  async logActivity(id, { type, summary, contact_id, client } = {}) { return null; },
  async addContact(id, contact, { force } = {}) { return null; },
  async addSite(site, { force } = {}) { return null; },
  async bulk(ids, fields, { onlyIfEmpty, onProgress } = {}) { return null; },
  async bulkRows(rows, { onProgress } = {}) { return null; },
  async edits({ before, limit, by, state, account } = {}) { return null; },
  async teamActivity({ days } = {}) { return null; },
  async contactsIndex() { return null; },
  async programs() { return null; },
  async saveProgram(k, program) { return null; },
  async settings() { return null; },
  async saveSettings(patch) { return null; },
  async suggestions({ account, owner, status } = {}) { return null; },
  async setSuggestion(id, status) { return null; },
  async runs({ limit } = {}) { return null; },
};
