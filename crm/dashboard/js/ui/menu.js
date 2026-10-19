// Menus and popovers in the top layer (Popover API; mount rules in spec 4.13), and isBusy().
// G0 stub; owner G1-C.

export async function openMenu(anchorEl, { items, search } = {}) {
  return null;
}

export function openPopover(anchorEl, safeHtml, { onOpen, onClose } = {}) {
  return { el: null, close() {} };
}

// True while a menu, popover or inline editor is open or the record panel is dirty.
export function isBusy() {
  return false;
}
