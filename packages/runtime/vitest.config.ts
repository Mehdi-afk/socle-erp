// SPDX-License-Identifier: LGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real services in Docker (SeaweedFS, ClamAV): one test file at a time, so that two heavy
    // containers never start together, and room for ClamAV to load its signatures.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
