// Deals (spec 2.2.3). Page module contract (spec 5.4). G0 stub; owner F4.
import { html, render } from "../core/dom.js";

const title = (ctx) => "Deals";

export default {
  id: "deals",
  title,
  mount(root, ctx) {
    render(root, html`<h1 tabindex="-1">${title(ctx)}</h1><p>Coming soon</p>`);
  },
  update(ctx, change) {},
  unmount() {},
};
