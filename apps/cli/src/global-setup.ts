// SPDX-License-Identifier: LGPL-3.0-only
//
// One throw-away PostgreSQL server for the whole test run of the package.
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
