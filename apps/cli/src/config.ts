// SPDX-License-Identifier: LGPL-3.0-only
//
// CLI configuration, read from the environment only (never from a committed file): the admin
// connection holds a password and is never printed.
import { delimiter, resolve } from 'node:path';

import { SocleError } from '@socle/framework';
import { z } from 'zod';

const env = z.object({
  SOCLE_DATABASE_URL: z.string({ error: 'SOCLE_DATABASE_URL is not set.' }).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    } catch {
      return false;
    }
  }, 'SOCLE_DATABASE_URL must be a postgres:// URL.'),
  SOCLE_MODULE_PATHS: z.string().optional(),
});

export interface CliConfig {
  /** Connection to the maintenance database (usually `postgres`), with the right to create databases. */
  readonly adminUrl: string;
  /** Directories holding one module per sub-directory. */
  readonly moduleRoots: readonly string[];
}

export class ConfigError extends SocleError {
  constructor(message: string) {
    super('cli.config', message);
  }
}

/** Reads the configuration; `moduleRoots` defaults to `<cwd>/modules`. */
export function readConfig(
  variables: Readonly<Record<string, string | undefined>>,
  cwd: string,
): CliConfig {
  const parsed = env.safeParse(variables);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join('\n'));
  }
  const paths = parsed.data.SOCLE_MODULE_PATHS?.split(delimiter).filter((p) => p !== '') ?? [];
  return {
    adminUrl: parsed.data.SOCLE_DATABASE_URL,
    moduleRoots: (paths.length > 0 ? paths : ['modules']).map((p) => resolve(cwd, p)),
  };
}
