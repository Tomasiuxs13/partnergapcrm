// Empty states (spec 4.10). G0 stub; owner G1-C.
import { raw } from "../core/dom.js";

export function emptyState({ title, body, action } = {}) { return raw(""); }
