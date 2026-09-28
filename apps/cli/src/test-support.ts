// SPDX-License-Identifier: LGPL-3.0-only
//
// Test helper (not exported): module directories written on disk for the duration of a test
// file. They live under apps/cli so that `@socle/*` imports resolve like in a real workspace.
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll } from 'vitest';

import { scaffoldModule } from './scaffold.js';

const TMP = join(import.meta.dirname, '..', '.tmp-tests');
const SPDX = '// SPDX-License-Identifier: LGPL-3.0-only\n';

export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterAll(async () => {
    for (const dir of created) await rm(dir, { recursive: true, force: true });
  });
  return async () => {
    const dir = join(TMP, randomUUID());
    await mkdir(dir, { recursive: true });
    created.push(dir);
    return dir;
  };
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.endsWith('.ts') ? `${SPDX}${text}` : text);
  }
}

/**
 * Writes into `root` the modules of the tests: `shop` (the scaffold, at `version`) and
 * `shop_vip`, which extends `shop.item`, adds a model and extends the form view. In 0.2.0,
 * `shop` renames `notes` to `remarks` through a hand-written migration.
 */
export async function writeShopModules(root: string, version: '0.1.0' | '0.2.0'): Promise<void> {
  await scaffoldModule('shop', root);
  if (version === '0.2.0') {
    await writeFiles(join(root, 'shop'), {
      'manifest.ts': `import { defineManifest } from '@socle/framework';
export default defineManifest({
  name: 'shop', version: '0.2.0', label: { fr: 'shop' }, license: 'LGPL-3.0-only',
  edition: 'community', engines: { socle: '^0.1.0' },
});
`,
      'models/item.ts': `import { defineModel, f } from '@socle/framework';
export default defineModel({
  name: 'shop.item',
  fields: { name: f.char({ required: true }), remarks: f.text() },
});
`,
      'views/item.views.ts': `import { defineView, field, form, group } from '@socle/framework';
export default defineView({
  id: 'shop.item.form', model: 'shop.item', type: 'form',
  arch: form([group([field('name'), field('remarks')])]),
});
`,
      'migrations/0.2.0/pre.ts': `import type { MigrationContext } from '@socle/orm-pg';
export default async (context: MigrationContext): Promise<void> => {
  await context.renameColumn('shop.item', 'notes', 'remarks');
};
`,
    });
  }
  await writeFiles(join(root, 'shop_vip'), {
    'manifest.ts': `import { defineManifest } from '@socle/framework';
export default defineManifest({
  name: 'shop_vip', version: '0.1.0', label: { fr: 'shop vip' }, depends: ['shop'],
  license: 'LGPL-3.0-only', edition: 'community', engines: { socle: '^0.1.0' },
});
`,
    'models/item.ext.ts': `import { extendModel, f } from '@socle/framework';
export default extendModel('shop.item', { fields: { vip: f.boolean() } });
`,
    'models/level.ts': `import { defineModel, f } from '@socle/framework';
export default [defineModel({ name: 'shop_vip.level', fields: { name: f.char() } })];
`,
    'views/item.views.ext.ts': `import { extendView, field } from '@socle/framework';
export default extendView('shop.item.form', [
  { at: "field[name='name']", position: 'after', node: field('vip') },
]);
`,
    'security/access.ts': `export default [
  { model: 'shop_vip.level', group: 'shop.group_user', read: true, write: true, create: true, unlink: true },
];
`,
    'README.md': 'Not a source file: ignored by the loader.\n',
  });
}
