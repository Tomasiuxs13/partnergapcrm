// <dialog> modals with a focus trap, and confirm (spec 4.13, 5.4). G0 stub; owner G1-C.

export function openModal({ title, body, actions, size, onClose } = {}) {
  return { el: null, close() {} };
}

export async function confirm({ title, body, confirmLabel, danger } = {}) {
  return false;
}
