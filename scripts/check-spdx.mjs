// SPDX-License-Identifier: LGPL-3.0-only
//
// Fails if a source file does not start with the expected SPDX header.
// Usage: node scripts/check-spdx.mjs [file ...]   (no argument = every tracked file)
// The expected license can be overridden with SPDX_LICENSE (e.g. LicenseRef-Socle-Pro).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LICENSE = process.env.SPDX_LICENSE ?? 'LGPL-3.0-only';
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const HASH_COMMENT = /\.(?:ya?ml|sh)$/;
const CHECKED = /^\.github\/workflows\/.+\.ya?ml$|^scripts\/.+\.sh$/;

const expected = (file) =>
  HASH_COMMENT.test(file)
    ? `# SPDX-License-Identifier: ${LICENSE}`
    : `// SPDX-License-Identifier: ${LICENSE}`;

const args = process.argv.slice(2);
const files = (
  args.length > 0
    ? args
    : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
)
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => SOURCE.test(file) || CHECKED.test(file));

const failures = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  // A shebang may precede the header.
  const header = lines[0]?.startsWith('#!') ? lines[1] : lines[0];
  if (header !== expected(file)) failures.push(file);
}

if (failures.length > 0) {
  console.error(`Missing or wrong SPDX header (expected "${LICENSE}") in:`);
  for (const file of failures) console.error(`  - ${file}`);
  process.exit(1);
}
console.log(`SPDX headers OK (${files.length} files).`);
