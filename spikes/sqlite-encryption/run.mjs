// SPDX-License-Identifier: LGPL-3.0-only
//
// Serves the benchmark on 127.0.0.1, opens it in a headless Chromium browser (Edge or Chrome)
// with a throw-away profile, waits for the results and prints them.
// Usage: node run.mjs [rows=20000] [runs=3]    Browser: BROWSER=/path/to/chrome (optional).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const [rows = '20000', runs = '3'] = process.argv.slice(2);
const TYPES = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

const VARIANTS = new Set([
  'official-plain',
  'mc-plain',
  'mc-chacha20',
  'mc-chacha20-kdf1',
  'mc-sqlcipher-aes256',
  'official-field-aesgcm',
]);

const candidates = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed list and $BROWSER set by the operator
].filter((path) => path !== undefined && existsSync(path));
const browser = candidates[0];
if (browser === undefined) throw new Error('No Chromium browser found: set BROWSER.');

let finish;
const done = new Promise((resolve) => (finish = resolve));

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/result') {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      response.end('ok');
      const message = JSON.parse(body);
      // Only known variant names are echoed (the body comes from the page).
      if (VARIANTS.has(message.partial)) console.error(`done: ${String(message.partial)}`);
      if (message.variants || message.fatal) finish(message);
    });
    return;
  }
  // Static files, confined to this directory.
  const path = normalize(
    join(root, decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to this directory just above
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || !existsSync(path)) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to this directory
  response.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const profile = mkdtempSync(join(tmpdir(), 'socle-spike-'));
const child = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${String(port)}/index.html?n=${rows}&runs=${runs}`,
  ],
  { stdio: 'ignore' },
);
const result = await done;
child.kill();
server.close();
console.log(JSON.stringify(result, null, 2));
