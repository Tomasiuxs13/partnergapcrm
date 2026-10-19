// createList: table at >= 640 px, cards below; sort, paging, selection, CSV (spec 4.7, 5.4).
// G0 stub; owner G1-C.

export function createList(root, { id, rows, fetchPage, columns, sort, pageSize, selectable, bulk,
  csv = true, csvName, empty, queueLabel } = {}) {
  return {
    refresh() {},
    selected() { return []; },
    destroy() {},
  };
}
