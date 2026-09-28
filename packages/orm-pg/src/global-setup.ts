// SPDX-License-Identifier: LGPL-3.0-only
//
// Starts ONE throw-away PostgreSQL server for the whole test run of the package and shares
// its URL with the test files (each test still creates its own database). Starting one
// container per test file made parallel runs heavy enough to crash test workers.
import { startPostgres } from '@socle/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startPostgres();
  project.provide('pgUrl', server.url);
  return () => server.stop();
}
