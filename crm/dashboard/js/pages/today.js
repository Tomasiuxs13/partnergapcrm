// Today (spec 2.2.1). Page module contract (spec 5.4). G0 stub; owner F2.
import { html, render } from "../core/dom.js";

const title = (ctx) => "Today";

export default {
  id: "today",
  title,
  mount(root, ctx) {
    render(root, html`<h1 tabindex="-1">${title(ctx)}</h1><p>Coming soon</p>`);
  },
  update(ctx, change) {},
  unmount() {},
};
