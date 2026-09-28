// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '@socle/framework';

import { parseCommand, USAGE, type Command } from './args.js';
import {
  dbBackup,
  dbCreate,
  dbDrop,
  dbRestore,
  moduleInstall,
  moduleList,
  moduleUninstall,
  moduleUpgrade,
  type Output,
} from './commands.js';
import { readConfig } from './config.js';
import { scaffoldModule } from './scaffold.js';

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly out: Output;
  readonly err: Output;
}

async function run(command: Command, io: Io): Promise<boolean> {
  if (command.kind === 'help') {
    io.out.line(USAGE);
    return true;
  }
  if (command.kind === 'scaffold.module') {
    const created = await scaffoldModule(command.name, command.dir);
    io.out.line(`Created module ${command.name} in ${command.dir}:`);
    for (const file of created) io.out.line(`  ${file}`);
    io.out.line('Run "pnpm install" to link it into the workspace.');
    return true;
  }
  const context = { config: readConfig(io.env, io.cwd), out: io.out, cwd: io.cwd };
  switch (command.kind) {
    case 'db.create':
      await dbCreate(context, command.tenant);
      return true;
    case 'db.drop':
      return dbDrop(context, command.tenant, command.yes);
    case 'db.backup':
      await dbBackup(context, command.tenant);
      return true;
    case 'db.restore':
      return dbRestore(context, command.tenant, command.snapshot, command.yes);
    case 'module.list':
      await moduleList(context, command.tenant);
      return true;
    case 'module.install':
      await moduleInstall(context, command.tenant, command.modules, command.demo);
      return true;
    case 'module.upgrade':
      await moduleUpgrade(context, command.tenant, command.modules);
      return true;
    case 'module.uninstall':
      return moduleUninstall(
        context,
        command.tenant,
        command.modules,
        command.yes,
        command.exportDir,
      );
  }
}

/**
 * Runs `socle` with `argv` (without the node and script paths). Returns the exit code: 0 on
 * success, 1 on error or when a destructive command was not confirmed.
 */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let debug = argv.includes('--debug');
  try {
    const parsed = parseCommand(argv);
    debug = parsed.debug;
    return (await run(parsed.command, io)) ? 0 : 1;
  } catch (error) {
    // Known errors carry a message meant for the user; anything else is a bug: its stack
    // only with --debug (it may contain internals).
    if (debug && error instanceof Error) io.err.line(error.stack ?? error.message);
    else if (error instanceof SocleError) io.err.line(`Error: ${error.message}`);
    else io.err.line(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
