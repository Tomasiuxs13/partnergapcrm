// Clients list #clients and client page #clients/<slug> (spec 2.2.4). Page module contract (spec 5.4).
// G0 stub; owner F5. The client page shows the slug as its title until F5 looks up the client.
import { html, render } from "../core/dom.js";

const title = (ctx) => (ctx && ctx.route && ctx.route.sub) || "Clients";

export default {
  id: "clients",
  title,
  mount(root, ctx) {
    render(root, html`<h1 tabindex="-1">${title(ctx)}</h1><p>Coming soon</p>`);
  },
  update(ctx, change) {},
  unmount() {},
};
