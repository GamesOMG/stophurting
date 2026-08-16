// Reads a captured fixture off disk. Exists so the source adapters in sources.mjs can be driven
// by check-au-adapter.mjs against REAL bytes without a network call — the adapters themselves,
// not a re-implementation of them.
//
// ⛔ Production never passes `fixtures`, so this module is never touched by a real run. It is the
// only seam in the adapters, and it is one argument wide on purpose: the moment a harness can
// swap out more than the input, it stops testing the thing that ships.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function load(dir, name, optional = false) {
  const f = path.join(dir, name);
  if (!existsSync(f)) {
    // Only 3 of the 25 feed items have a captured notice page — capturing all 25 would be 2 MB of
    // near-identical markup. A missing page is therefore EXPECTED, and returning '' drives the
    // adapter down its real fallback path (extract from the RSS body instead), which is a path
    // worth exercising rather than one worth mocking away.
    if (optional) return '';
    throw new Error(`fixture missing: ${f}`);
  }
  return readFileSync(f, 'utf8');
}
