// SPDX-License-Identifier: LGPL-3.0-only
//
// Loading modules from disk, planning module operations and scaffolding (no database).
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ModuleLocationError, MissingDependencyError } from '@socle/framework';
import { describe, expect, it } from 'vitest';

import { loadModules, ModuleLoadError } from './loader.js';
import { compose, planInstall, planUninstall, planUpgrade, PlanError } from './plan.js';
import { scaffoldModule, ScaffoldError } from './scaffold.js';
import { useTempDirs, writeFiles, writeShopModules } from './test-support.js';

const tempDir = useTempDirs();
const installed = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('scaffold', () => {
  it('creates a module that loads and composes as is', async () => {
    const root = await tempDir();
    const files = await scaffoldModule('fleet', root);
    expect(files).toContain('manifest.ts');
    for (const file of files) expect(existsSync(join(root, 'fleet', file)), file).toBe(true);

    const set = await loadModules([root]);
    expect(set.catalog.names()).toEqual(['fleet']);
    const { registry, security } = compose(set, ['fleet']);
    expect(registry.has('fleet.item')).toBe(true);
    expect(security).toBeDefined();
  });

  it('refuses an invalid name or an existing directory', async () => {
    const root = await tempDir();
    for (const name of ['Fleet', 'a', '../evil', 'fleet/x', 'fleet.x', '_fleet']) {
      await expect(scaffoldModule(name, root), name).rejects.toThrow(ScaffoldError);
    }
    await scaffoldModule('fleet', root);
    await expect(scaffoldModule('fleet', root)).rejects.toThrow(/already exists/);
  });
});

describe('module loader', () => {
  it('loads models, views, security and migrations by convention', async () => {
    const root = await tempDir();
    await writeShopModules(root, '0.2.0');
    const set = await loadModules([root]);

    expect(set.catalog.names()).toEqual(['shop', 'shop_vip']);
    const vip = set.get('shop_vip');
    expect(vip.models.models.map((m) => `${m.kind}:${m.name}`)).toEqual([
      'extend:shop.item',
      'define:shop_vip.level',
    ]);
    expect(vip.views.views.map((v) => v.kind)).toEqual(['extend']);
    expect(vip.security.access).toHaveLength(1);
    expect(vip.security.groups).toBeUndefined();
    expect(set.get('shop').migrations.map((m) => m.version)).toEqual(['0.2.0']);
    expect(set.get('shop').migrations[0]?.pre).toBeTypeOf('function');
    expect(() => set.get('ghost')).toThrow(ModuleLoadError);

    const { registry } = compose(set, ['shop', 'shop_vip']);
    expect(registry.field('shop.item', 'vip')?.type).toBe('boolean');
  });

  it('refuses malformed modules with the file at fault', async () => {
    const cases: [string, Record<string, string>, RegExp | (new (...args: never[]) => Error)][] = [
      ['models/bad.ts', { 'models/bad.ts': 'export default { nope: 1 };\n' }, /bad\.ts: every/],
      ['no default', { 'models/bad.ts': 'export const x = 1;\n' }, /no default export/],
      ['security', { 'security/access.ts': 'export default { model: "x" };\n' }, /array of access/],
      ['migration dir', { 'migrations/next/pre.ts': 'export default 1;\n' }, /not a SemVer/],
      ['migration step', { 'migrations/0.2.0/pre.ts': 'export default 1;\n' }, /async function/],
    ];
    for (const [label, files, expected] of cases) {
      const root = await tempDir();
      await scaffoldModule('shop', root);
      await writeFiles(join(root, 'shop'), files);
      await expect(loadModules([root]), label).rejects.toThrow(expected);
    }
  });

  it('checks the modules together through the catalog', async () => {
    const root = await tempDir();
    await writeShopModules(root, '0.1.0');
    await writeFiles(join(root, 'misplaced'), {
      'manifest.ts': `import { defineManifest } from '@socle/framework';
export default defineManifest({ name: 'other', version: '1.0.0', label: { fr: 'x' },
  license: 'LGPL-3.0-only', edition: 'community', engines: { socle: '^0.1.0' } });
`,
    });
    await expect(loadModules([root])).rejects.toThrow(ModuleLocationError);

    const alone = await tempDir();
    await writeShopModules(alone, '0.1.0');
    // shop_vip without its dependency.
    await rm(join(alone, 'shop'), { recursive: true });
    await expect(loadModules([alone])).rejects.toThrow(MissingDependencyError);
    await expect(loadModules([join(alone, 'missing')])).rejects.toThrow(/does not exist/);
  });

  it('refuses a module directory that links outside of its root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await scaffoldModule('evil', outside);
    await mkdir(root, { recursive: true });
    // A junction needs no privilege on Windows; elsewhere it is a plain directory link.
    await symlink(join(outside, 'evil'), join(root, 'evil'), 'junction');
    await expect(loadModules([root])).rejects.toThrow(/outside of the module directory/);
  });

  it('refuses a source file that links outside of its root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await scaffoldModule('shop', root);
    await writeFiles(outside, { 'loot.ts': 'export default [];\n' });
    try {
      await symlink(join(outside, 'loot.ts'), join(root, 'shop', 'models', 'loot.ts'), 'file');
    } catch {
      // File links need a privilege on Windows (developer mode): covered on the Linux CI.
      return;
    }
    await expect(loadModules([root])).rejects.toThrow(/outside of the module directory/);
  });
});

describe('module plans', () => {
  it('installs dependencies first and skips what is installed', async () => {
    const root = await tempDir();
    await writeShopModules(root, '0.1.0');
    const { catalog } = await loadModules([root]);

    expect(planInstall(catalog, ['shop_vip'], installed({}))).toEqual({
      modules: ['shop', 'shop_vip'],
      install: ['shop', 'shop_vip'],
    });
    expect(planInstall(catalog, ['shop_vip'], installed({ shop: '0.1.0' })).install).toEqual([
      'shop_vip',
    ]);
    expect(planInstall(catalog, ['shop'], installed({ shop: '0.1.0' })).install).toEqual([]);
    expect(() => planInstall(catalog, ['ghost'], installed({}))).toThrow();
  });

  it('upgrades newer versions only and refuses a downgrade', async () => {
    const root = await tempDir();
    await writeShopModules(root, '0.2.0');
    const { catalog } = await loadModules([root]);
    const both = installed({ shop: '0.1.0', shop_vip: '0.1.0' });

    expect(planUpgrade(catalog, [], both).upgrade).toEqual([
      { name: 'shop', from: '0.1.0', to: '0.2.0' },
    ]);
    expect(planUpgrade(catalog, ['shop_vip'], both).upgrade).toEqual([]);
    expect(() => planUpgrade(catalog, ['shop'], installed({}))).toThrow(PlanError);
    expect(() => planUpgrade(catalog, [], installed({ shop: '0.3.0', shop_vip: '0.1.0' }))).toThrow(
      /downgrade/,
    );
  });

  it('uninstalls dependents too, dependents first', async () => {
    const root = await tempDir();
    await writeShopModules(root, '0.1.0');
    const { catalog } = await loadModules([root]);
    const both = installed({ shop: '0.1.0', shop_vip: '0.1.0' });

    expect(planUninstall(catalog, ['shop'], both)).toEqual({
      remove: ['shop_vip', 'shop'],
      modules: [],
    });
    expect(planUninstall(catalog, ['shop_vip'], both)).toEqual({
      remove: ['shop_vip'],
      modules: ['shop'],
    });
    expect(() => planUninstall(catalog, ['shop_vip'], installed({ shop: '0.1.0' }))).toThrow(
      PlanError,
    );
    expect(() => planInstall(catalog, [], installed({ shop_vip: '0.1.0' }))).not.toThrow();
    expect(() => planUpgrade(catalog, [], installed({ ghost: '1.0.0' }))).toThrow();
  });

  it('fails before any database change when a view extension finds nothing', async () => {
    const root = await tempDir();
    await writeShopModules(root, '0.1.0');
    await writeFiles(join(root, 'shop_vip'), {
      'views/item.views.ext.ts': `import { extendView, field } from '@socle/framework';
export default extendView('shop.item.form', [
  { at: "field[name='ghost']", position: 'after', node: field('vip') },
]);
`,
    });
    const set = await loadModules([root]);
    expect(() => compose(set, ['shop', 'shop_vip'])).toThrow();
  });
});
