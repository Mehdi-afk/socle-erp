#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-only
//
// Entry point of the `socle` command: the TypeScript sources run directly on Node (ADR 011).
import './ts-hooks.mjs';

const { main } = await import('../src/main.ts');
const line = (stream) => ({ line: (text) => stream.write(`${text}\n`) });

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: line(process.stdout),
  err: line(process.stderr),
});
