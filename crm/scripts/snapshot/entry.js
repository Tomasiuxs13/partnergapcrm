// Snapshot entry (spec 4.14). Owner G3-6. The bundle starts here: app.js is evaluated first (it starts the
// boot, which waits for meta.load() on a microtask), then the snapshot bar registers before the router starts.
import * as app from "../../dashboard/js/app.js";
import { start } from "./ui.js";

start();

export const pages = app.PAGES.map((p) => p.id);
