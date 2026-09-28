// SPDX-License-Identifier: LGPL-3.0-only
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCommand, UsageError } from './args.js';
import { ConfigError, databaseUrl, readConfig, tenantDatabase } from './config.js';

const command = (line: string) => parseCommand(line.split(' ').filter(Boolean)).command;

describe('command line', () => {
  it('parses every command', () => {
    expect(command('')).toEqual({ kind: 'help' });
    expect(command('db create acme')).toEqual({ kind: 'db.create', tenant: 'acme' });
    expect(command('db drop acme --yes')).toEqual({ kind: 'db.drop', tenant: 'acme', yes: true });
    expect(command('db drop acme')).toEqual({ kind: 'db.drop', tenant: 'acme', yes: false });
    expect(command('db restore acme')).toEqual({
      kind: 'db.restore',
      tenant: 'acme',
      snapshot: undefined,
      yes: false,
    });
    expect(command('db restore acme snap_1 --yes')).toMatchObject({
      snapshot: 'snap_1',
      yes: true,
    });
    expect(command('module install acme sale stock')).toEqual({
      kind: 'module.install',
      tenant: 'acme',
      modules: ['sale', 'stock'],
    });
    expect(command('module upgrade acme')).toEqual({
      kind: 'module.upgrade',
      tenant: 'acme',
      modules: [],
    });
    expect(command('module uninstall acme sale --yes --export-dir out')).toEqual({
      kind: 'module.uninstall',
      tenant: 'acme',
      modules: ['sale'],
      yes: true,
      exportDir: 'out',
    });
    expect(command('module uninstall acme sale')).toMatchObject({
      yes: false,
      exportDir: 'socle-exports',
    });
    expect(command('scaffold module fleet --dir extra')).toEqual({
      kind: 'scaffold.module',
      name: 'fleet',
      dir: 'extra',
    });
    expect(parseCommand(['db', 'create', 'acme', '--debug']).debug).toBe(true);
    expect(command('db create acme --help')).toEqual({ kind: 'help' });
  });

  it('rejects anything else with a usage error', () => {
    for (const line of [
      'db',
      'db rename acme',
      'db create',
      'db create acme extra',
      'db create acme --yes',
      'db drop acme --export-dir x',
      'db restore acme a b',
      'module install acme',
      'module uninstall acme',
      'scaffold module',
      'scaffold module a b',
      'module list acme --force',
    ]) {
      expect(() => command(line), line).toThrow(UsageError);
    }
  });
});

describe('configuration', () => {
  it('maps a tenant to its database, injectively', () => {
    expect(tenantDatabase('acme')).toBe('socle_acme');
    expect(tenantDatabase('acme-sarl')).toBe('socle_acme_sarl');
    for (const bad of ['a', 'Acme', '1acme', 'acme-', 'ac--me', 'ac_me', 'x'.repeat(33), '../x']) {
      expect(() => tenantDatabase(bad), bad).toThrow(ConfigError);
    }
  });

  it('points the admin URL at another database without printing it', () => {
    expect(databaseUrl('postgres://u:p@h:5432/postgres', 'socle_acme')).toBe(
      'postgres://u:p@h:5432/socle_acme',
    );
    expect(() => databaseUrl('postgres://u:p@h/postgres', 'x; drop')).toThrow();
  });

  it('reads the environment', () => {
    const cwd = resolve('/work');
    expect(readConfig({ SOCLE_DATABASE_URL: 'postgres://u:p@h/postgres' }, cwd)).toEqual({
      adminUrl: 'postgres://u:p@h/postgres',
      moduleRoots: [resolve(cwd, 'modules')],
    });
    const paths = ['a', resolve('/b')].join(process.platform === 'win32' ? ';' : ':');
    expect(
      readConfig({ SOCLE_DATABASE_URL: 'postgresql://h/db', SOCLE_MODULE_PATHS: paths }, cwd)
        .moduleRoots,
    ).toEqual([resolve(cwd, 'a'), resolve('/b')]);
    expect(() => readConfig({}, cwd)).toThrow(/SOCLE_DATABASE_URL is not set/);
    expect(() => readConfig({ SOCLE_DATABASE_URL: 'mysql://h/db' }, cwd)).toThrow(ConfigError);
    expect(() => readConfig({ SOCLE_DATABASE_URL: 'not a url' }, cwd)).toThrow(ConfigError);
  });
});
