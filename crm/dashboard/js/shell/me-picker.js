// "Signed in as X · change" in the footer, and the name prompt before a first edit (spec D4, 2.1, 2.2.8).
// Owner B1. No side effects at import time.
//
// openMePicker(anchorEl) resolves to the picked name, or null when nothing was picked. The caller sets it
// (shell.js: me.set; me.ensure for the first-edit prompt). Both open the same small form as the sign-in
// page: "Your name" (the team, A to Z, plus "Someone else (type your name)", which shows a text field) and
// "Use this name". A select rather than a menu, so every name and "Someone else" stay in view however long
// the team list grows (Settings can add people).
//   - With an anchor (the footer "change" link): "Change your name", the current name preselected.
//   - With no anchor (me.ensure before a first edit, when the sign-in name is missing): "Who's making this
//     change?" with one line on why.
// A typed name is 2-40 letters (spaces, ' and - are fine), as on the sign-in form. It is never added to
// the team menus: Settings (Help) owns the team list.
import { html } from "../core/dom.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import { openModal } from "../ui/dialog.js";

const OTHER = "__other";
let seq = 0;

/** A typed name, cleaned, or "" when it isn't 2-40 letters (spaces, ' and - allowed). */
export function cleanTypedName(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 40) return "";
  if (!/^[\p{L}\p{M}' ’-]+$/u.test(s) || (s.match(/\p{L}/gu) || []).length < 2) return "";
  return s;
}

/** The active team names from meta, A to Z (the sign-in form's order). */
export function teamNames(meta = metaMod.get()) {
  return ((meta && meta.team) || [])
    .filter((m) => m && m.name && m.active !== false)
    .map((m) => String(m.name))
    .sort((a, b) => a.localeCompare(b));
}

// The small form: the team list plus "Someone else", which shows a text field. Resolves to a name or null.
function askName({ title, intro = "" } = {}) {
  const names = teamNames();
  const cur = me.get() || "";
  const pickOther = !!cur && !names.includes(cur);
  const id = "me-pick-" + ++seq;
  const body = html`<div class="ui-form">
${intro ? html`<p class="ui-faint">${intro}</p>` : ""}
<label class="ui-field" for="${id}-who"><span class="ui-label">Your name</span>
<select class="ui-input" id="${id}-who" name="who">
${cur ? "" : html`<option value="" selected disabled>Pick your name</option>`}
${names.map((n) => html`<option value="${n}"${!pickOther && n === cur ? html` selected` : ""}>${n}</option>`)}
<option value="${OTHER}"${pickOther ? html` selected` : ""}>Someone else (type your name)</option>
</select></label>
<label class="ui-field" for="${id}-other" data-other${pickOther ? "" : html` hidden`}><span class="ui-label">Type your name</span>
<input class="ui-input" id="${id}-other" name="who_other" type="text" maxlength="40" autocomplete="name" value="${pickOther ? cur : ""}">
<span class="ui-small">Your edits are signed with this name.</span></label>
<p class="ui-error" id="${id}-err" role="alert" hidden></p>
</div>`;
  let picked = null;
  const m = openModal({
    title,
    body,
    size: "sm",
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      {
        label: "Use this name",
        kind: "primary",
        onClick: (modal) => {
          const sel = modal.el.querySelector("select[name=who]");
          const inp = modal.el.querySelector("input[name=who_other]");
          const err = modal.el.querySelector(".ui-error");
          const typed = sel.value === OTHER;
          const name = typed ? cleanTypedName(inp.value) : sel.value;
          if (!name) {
            err.textContent = typed ? "Type your name: 2–40 letters (spaces, ' and - are fine)." : "Pick your name.";
            err.hidden = false;
            const bad = typed ? inp : sel;
            bad.setAttribute("aria-invalid", "true");
            bad.setAttribute("aria-describedby", id + "-err");
            bad.focus();
            return false;
          }
          picked = name;
          return true;
        },
      },
    ],
  });
  const sel = m.el.querySelector("select[name=who]");
  const box = m.el.querySelector("[data-other]");
  const inp = m.el.querySelector("input[name=who_other]");
  const err = m.el.querySelector(".ui-error");
  const clearError = () => {
    err.hidden = true;
    for (const el of [sel, inp]) el.removeAttribute("aria-invalid");
  };
  sel.addEventListener("change", () => {
    clearError();
    box.hidden = sel.value !== OTHER;
    if (sel.value === OTHER) inp.focus();
  });
  inp.addEventListener("input", () => {
    if (!err.hidden) clearError();
  });
  if (pickOther) inp.focus();
  else sel.focus();
  return m.result.then(() => picked);
}

export async function openMePicker(anchorEl) {
  if (typeof document === "undefined") return null;
  if (!anchorEl) return askName({ title: "Who's making this change?", intro: "Edits are signed with your name. You can change it later in the footer." });
  return askName({ title: "Change your name" });
}
