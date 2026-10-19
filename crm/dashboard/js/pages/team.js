// Team overview (spec 2.2.5). Page module contract (spec 5.4). G0 stub; owner F6.
import { html, render } from "../core/dom.js";

const title = (ctx) => "Team overview";

export default {
  id: "team",
  title,
  mount(root, ctx) {
    render(root, html`<h1 tabindex="-1">${title(ctx)}</h1><p>Coming soon</p>`);
  },
  update(ctx, change) {},
  unmount() {},
};
