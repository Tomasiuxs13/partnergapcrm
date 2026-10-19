// App shell: sidebar or bottom tabs from NAV, top bar, footer, banners (read-only, freshness, build).
// G0 stub; owner G1-A. Renders a bare sidebar and <main id="main">. NAV is passed in by app.js
// (nav metadata lives only in app.js, and shell.js must not import app.js).
import { html, render } from "../core/dom.js";
import { href, onChange } from "../core/router.js";

export function mount({ nav = [] } = {}) {
  const app = document.querySelector(".app");
  if (!app) return null;
  const items = nav.slice().sort((a, b) => a.order - b.order);
  render(app, html`<aside class="side">
  <nav aria-label="Main">${items.map((n) => html`<a href="${href(n.id)}" data-nav="${n.id}">${n.label}</a>`)}</nav>
  <a href="/logout">Sign out</a>
</aside>
<main id="main" class="main" tabindex="-1"></main>`);
  onChange((cur) => {
    for (const a of app.querySelectorAll("[data-nav]")) {
      if (a.getAttribute("data-nav") === cur.page) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  });
  return app.querySelector("#main");
}
