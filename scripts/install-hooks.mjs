// SPDX-License-Identifier: LGPL-3.0-only
//
// Installs the lefthook Git hooks after `pnpm install` on a developer machine.
// Skipped in CI, where the same checks run as workflow steps.
import { execSync } from 'node:child_process';

if (process.env.CI) {
  console.log('CI detected: Git hooks not installed.');
} else {
  execSync('pnpm exec lefthook install', { stdio: 'inherit' });
}
