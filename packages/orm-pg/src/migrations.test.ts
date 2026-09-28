// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { SchemaError } from './errors.js';
import { migrationsBetween, type ModuleMigration } from './migrations.js';

const at = (...versions: string[]): ModuleMigration[] => versions.map((version) => ({ version }));
const versions = (list: ModuleMigration[]): string[] => list.map((m) => m.version);

describe('migrationsBetween', () => {
  const all = at('1.10.0', '1.2.0', '2.0.0', '1.1.0');

  it('selects from < version ≤ to, in SemVer order (not text order)', () => {
    expect(versions(migrationsBetween(all, '1.1.0', '2.0.0'))).toEqual([
      '1.2.0',
      '1.10.0',
      '2.0.0',
    ]);
    expect(versions(migrationsBetween(all, '1.2.0', '1.10.0'))).toEqual(['1.10.0']);
  });

  it('runs nothing on a first installation or when the version does not change', () => {
    expect(migrationsBetween(all, null, '2.0.0')).toEqual([]);
    expect(migrationsBetween(all, '2.0.0', '2.0.0')).toEqual([]);
  });

  it('refuses downgrades, invalid versions and duplicate migrations', () => {
    expect(() => migrationsBetween(all, '2.0.0', '1.0.0')).toThrow(/Downgrade/);
    expect(() => migrationsBetween(all, '1.0.0', 'latest')).toThrow(SchemaError);
    expect(() => migrationsBetween(at('1.0'), '0.1.0', '1.0.0')).toThrow(
      /Invalid migration version/,
    );
    expect(() => migrationsBetween(at('1.1.0', '1.1.0'), '1.0.0', '2.0.0')).toThrow(
      /Two migrations/,
    );
  });
});
