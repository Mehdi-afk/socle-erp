// SPDX-License-Identifier: LGPL-3.0-only
//
// Downloads the two SQLite WASM builds compared by ADR 007 and checks their SHA-256 before
// extracting them into ./builds (ignored by Git). Extraction uses the system `tar`
// (bsdtar reads zip archives on Windows and macOS; zip archives use `unzip` on Linux).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const builds = join(here, 'builds');

const ARCHIVES = [
  {
    name: 'mc',
    file: 'sqlite3mc-wasm.zip',
    url: 'https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.5.1/sqlite3mc-2.5.1-sqlite-3.53.4-wasm.zip',
    sha256: '761a41b8dc996cfa21f193fc044739fbb0c4a31a1fd657a4df49cc59085577ce',
  },
  {
    name: 'official',
    file: 'sqlite-wasm.tgz',
    url: 'https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.53.4-build1.tgz',
    sha256: '24f46db4ce5248fa8f8f24b67e81909ab1a9c152f42a4796a32c6d385a6fb62b',
  },
];

// Every path below is built from constants of this file, inside ./builds.

mkdirSync(builds, { recursive: true });
for (const archive of ARCHIVES) {
  const response = await fetch(archive.url);
  if (!response.ok) throw new Error(`${archive.url}: HTTP ${String(response.status)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== archive.sha256) {
    throw new Error(
      `${archive.file}: SHA-256 ${digest} does not match the pinned ${archive.sha256}`,
    );
  }
  const target = join(builds, archive.name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  mkdirSync(target, { recursive: true });
  const path = join(builds, archive.file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  writeFileSync(path, bytes);
  if (process.platform === 'linux' && archive.file.endsWith('.zip')) {
    execFileSync('unzip', ['-q', '-o', path, '-d', target], { stdio: 'inherit' });
  } else {
    // Windows' own bsdtar (reads zip), not a GNU tar that may come first in PATH.
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    execFileSync(tar, ['-xf', path, '-C', target], { stdio: 'inherit' });
  }
  console.log(`${archive.name}: verified and extracted`);
}
