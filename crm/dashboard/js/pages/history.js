// Edit history (spec 2.2.6). Page module contract (spec 5.4). G0 stub; owner F8.
import { html, render } from "../core/dom.js";

const title = (ctx) => "Edit history";

export default {
  id: "history",
  title,
  mount(root, ctx) {
    render(root, html`<h1 tabindex="-1">${title(ctx)}</h1><p>Coming soon</p>`);
  },
  update(ctx, change) {},
  unmount() {},
};
