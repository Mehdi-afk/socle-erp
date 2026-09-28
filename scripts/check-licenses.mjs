// SPDX-License-Identifier: LGPL-3.0-only
//
// Fails if any installed dependency (prod or dev) has a license outside the allow-list
// of ARCHITECTURE.md §11.4. Explicit, justified exceptions live in scripts/license-exceptions.json.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
]);

/** @type {Record<string, { license: string, reason: string }>} */
const exceptions = JSON.parse(
  readFileSync(new URL('./license-exceptions.json', import.meta.url), 'utf8'),
);

/**
 * Evaluates a simple SPDX expression: "A OR B" passes if one term passes,
 * "A AND B" passes if all terms pass. Parentheses are ignored (flat expressions only).
 */
function isAllowed(expression) {
  const clean = expression.replace(/[()]/g, '').trim();
  if (/ OR /.test(clean)) return clean.split(/ OR /).some((term) => isAllowed(term));
  if (/ AND /.test(clean)) return clean.split(/ AND /).every((term) => isAllowed(term));
  return ALLOWED.has(clean);
}

// Fixed command string (no user input): a shell is needed to resolve pnpm.cmd on Windows.
const raw = execSync('pnpm licenses list --json', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
/** @type {Record<string, Array<{ name: string, versions: string[] }>>} */
const byLicense = JSON.parse(raw);

const failures = [];
let count = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    count += 1;
    if (isAllowed(license)) continue;
    const exception = exceptions[pkg.name];
    if (exception && exception.license === license) continue;
    failures.push(`${pkg.name}@${pkg.versions.join(',')} — ${license}`);
  }
}

if (failures.length > 0) {
  console.error('Dependencies with a license outside the allow-list:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    'Remove the dependency, or add a justified entry to scripts/license-exceptions.json.',
  );
  process.exit(1);
}
console.log(`Dependency licenses OK (${count} packages).`);
