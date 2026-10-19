// URL-synced filter chips (spec 4.7, 5.4). G0 stub; owner G1-C.

export function createFilterBar(root, { fields, params, onChange } = {}) {
  return { destroy() {} };
}

export function applyFilters(records, params, { meta, me } = {}) {
  return Array.isArray(records) ? records.slice() : [];
}
