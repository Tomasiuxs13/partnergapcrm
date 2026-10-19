// Help (spec 2.2.7). Page module contract (spec 5.4). G0 stub; owner F8.
import { html, render } from "../core/dom.js";

const title = (ctx) => "Help";

export default {
  id: "help",
  title,
  mount(root, ctx) {
    render(root, html`<h1 tabindex="-1">${title(ctx)}</h1><p>Coming soon</p>`);
  },
  update(ctx, change) {},
  unmount() {},
};
