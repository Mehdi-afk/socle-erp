// SPDX-License-Identifier: LGPL-3.0-only
//
// Command line grammar (pure). Destructive commands only act with an explicit `--yes`.
import { parseArgs } from 'node:util';

import { SocleError } from '@socle/framework';

export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'db.create' | 'db.backup' | 'module.list'; readonly tenant: string }
  | { readonly kind: 'db.drop'; readonly tenant: string; readonly yes: boolean }
  | {
      readonly kind: 'db.restore';
      readonly tenant: string;
      readonly snapshot: string | undefined;
      readonly yes: boolean;
    }
  | {
      readonly kind: 'module.install';
      readonly tenant: string;
      readonly modules: readonly string[];
      readonly demo: boolean;
    }
  | {
      readonly kind: 'module.upgrade';
      readonly tenant: string;
      readonly modules: readonly string[];
    }
  | {
      readonly kind: 'module.uninstall';
      readonly tenant: string;
      readonly modules: readonly string[];
      readonly yes: boolean;
      readonly exportDir: string;
    }
  | { readonly kind: 'scaffold.module'; readonly name: string; readonly dir: string };

export class UsageError extends SocleError {
  constructor(message: string) {
    super('cli.usage', `${message}\nRun "socle help" for the list of commands.`);
  }
}

export const USAGE = `Usage: socle <command>

  db create <tenant>                     Create the tenant database
  db drop <tenant> --yes                 Delete the tenant database (its snapshots are kept)
  db backup <tenant>                     Take a snapshot of the tenant database
  db restore <tenant>                    List the snapshots of the tenant
  db restore <tenant> <snapshot> --yes   Replace the tenant database with a snapshot

  module list <tenant>                   Available and installed modules
  module install <tenant> <module...> [--demo]
                                         Install modules and their dependencies
                                         (--demo: also their demonstration data)
  module upgrade <tenant> [module...]    Upgrade modules (default: all installed)
  module uninstall <tenant> <module...> --yes [--export-dir <dir>]
                                         Uninstall modules and their dependents,
                                         exporting their data first (default: socle-exports)

  scaffold module <name> [--dir <dir>]   Create a module skeleton (default dir: modules)

Environment:
  SOCLE_DATABASE_URL   postgres:// URL of the maintenance database (right to create databases)
  SOCLE_MODULE_PATHS   module directories, separated by the path delimiter (default: modules)

Options: --debug prints the full error.`;

type Option = 'yes' | 'export-dir' | 'dir' | 'demo';

/** Options each command accepts, besides --help and --debug. */
const ACCEPTS: Record<string, readonly Option[]> = {
  'db.create': [],
  'db.drop': ['yes'],
  'db.backup': [],
  'db.restore': ['yes'],
  'module.list': [],
  'module.install': ['demo'],
  'module.upgrade': [],
  'module.uninstall': ['yes', 'export-dir'],
  'scaffold.module': ['dir'],
};

export interface ParsedArgs {
  readonly command: Command;
  readonly debug: boolean;
}

export function parseCommand(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        yes: { type: 'boolean' },
        'export-dir': { type: 'string' },
        dir: { type: 'string' },
        demo: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        debug: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const debug = values.debug === true;
  const [group, action, ...rest] = positionals;
  if (values.help === true || group === undefined || group === 'help') {
    return { command: { kind: 'help' }, debug };
  }
  const kind = `${group}.${action ?? ''}`;
  const accepted = ACCEPTS[kind];
  if (accepted === undefined) throw new UsageError(`Unknown command "${positionals.join(' ')}".`);
  for (const option of ['yes', 'export-dir', 'dir', 'demo'] as const) {
    if (values[option] !== undefined && !accepted.includes(option)) {
      throw new UsageError(`Option --${option} does not apply to "${group} ${action ?? ''}".`);
    }
  }

  const [first, ...others] = rest;
  const exactly = (count: number): void => {
    if (rest.length !== count) {
      throw new UsageError(`"${group} ${action ?? ''}" takes ${String(count)} argument(s).`);
    }
  };
  const tenant = (): string => {
    if (first === undefined) throw new UsageError(`"${group} ${action ?? ''}" needs a tenant.`);
    return first;
  };
  const yes = values.yes === true;

  switch (kind) {
    case 'db.create':
    case 'db.backup':
    case 'module.list':
      exactly(1);
      return { command: { kind, tenant: tenant() }, debug };
    case 'db.drop':
      exactly(1);
      return { command: { kind, tenant: tenant(), yes }, debug };
    case 'db.restore':
      if (rest.length > 2) throw new UsageError('"db restore" takes a tenant and a snapshot.');
      return { command: { kind, tenant: tenant(), snapshot: others[0], yes }, debug };
    case 'module.install':
    case 'module.uninstall':
      if (others.length === 0) throw new UsageError(`"${group} ${action ?? ''}" needs modules.`);
      return kind === 'module.install'
        ? {
            command: { kind, tenant: tenant(), modules: others, demo: values.demo === true },
            debug,
          }
        : {
            command: {
              kind,
              tenant: tenant(),
              modules: others,
              yes,
              exportDir: values['export-dir'] ?? 'socle-exports',
            },
            debug,
          };
    case 'module.upgrade':
      return { command: { kind, tenant: tenant(), modules: others }, debug };
    default:
      exactly(1);
      if (first === undefined) throw new UsageError('"scaffold module" needs a module name.');
      return {
        command: { kind: 'scaffold.module', name: first, dir: values.dir ?? 'modules' },
        debug,
      };
  }
}
