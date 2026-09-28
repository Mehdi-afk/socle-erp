// SPDX-License-Identifier: LGPL-3.0-only
//
// Runs the TypeScript sources directly on Node (type stripping, ADR 011): relative imports are
// written `./x.js` for the type checker; when no such file exists, `./x.ts` is loaded instead.
import { registerHooks } from 'node:module';

const RELATIVE_JS = /^\.{1,2}\/.*\.js$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !RELATIVE_JS.test(specifier)) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
