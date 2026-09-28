// SPDX-License-Identifier: LGPL-3.0-only
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // acceptance/ is a workspace package of its own, with its own run.
    exclude: [...configDefaults.exclude, 'acceptance/**'],
  },
});
