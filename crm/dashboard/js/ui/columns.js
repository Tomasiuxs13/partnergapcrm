// Column catalog for createList: {id, label, cell(row), sort?(row), priority, csv?(row)} (spec 4.7).
// G0 stub; owner G1-C. The API below is a placeholder that G1-C may change.

export const COLUMNS = {};

export function column(id) {
  return COLUMNS[id] || null;
}
