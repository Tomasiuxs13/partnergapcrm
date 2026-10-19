// Lets `node --test tests/unit/` (the test:unit script) work on Node 22, whose test runner treats a
// directory argument as one module instead of searching it: Node loads this directory's index.js,
// and this file imports every *.test.mjs beside it, in name order, into that one test process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.mjs")).sort()) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
