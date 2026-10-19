// Synthetic fixture seed (spec 8): 600 sites on *.example.test, 2,000 contacts, activity, edits,
// suggestions and kv_meta overrides; dates relative to the run day; deterministic.
// Shape: tests/fixtures/SCHEMA.md. G0 stub; owner G1-D. Prints the seed SQL to stdout.
import { fileURLToPath } from "node:url";

export function makeSeed({ today } = {}) {
  return "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(makeSeed());
