// SPDX-License-Identifier: LGPL-3.0-only
//
// `socle scaffold module <name>`: a module skeleton that installs as is (one model, its
// access rights, a form and a list view, a test), following ARCHITECTURE.md §3.3.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { parseManifest, SOCLE_VERSION, SocleError } from '@socle/framework';

export class ScaffoldError extends SocleError {
  constructor(message: string) {
    super('cli.scaffold', message);
  }
}

const SPDX = '// SPDX-License-Identifier: LGPL-3.0-only\n';

/** Nearest `tsconfig.base.json` above `dir`, as a path relative to `from`. */
function baseConfig(dir: string, from: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const candidate = join(current, 'tsconfig.base.json');
    if (existsSync(candidate)) return relative(from, candidate).replaceAll('\\', '/');
    if (dirname(current) === current) return undefined;
  }
}

function files(name: string, tsconfigBase: string | undefined): Record<string, string> {
  const model = `${name}.item`;
  const title = name.replaceAll('_', ' ');
  const tsconfig = tsconfigBase
    ? { extends: tsconfigBase, compilerOptions: { types: ['node'] }, include: ['.'] }
    : {
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['.'],
      };
  return {
    'package.json': `${JSON.stringify(
      {
        name: `@socle/module-${name.replaceAll('_', '-')}`,
        version: '0.1.0',
        private: true,
        description: `Socle ERP module ${name}`,
        license: 'LGPL-3.0-only',
        type: 'module',
        scripts: { typecheck: 'tsc -p tsconfig.json', test: 'vitest run' },
        dependencies: { '@socle/framework': 'workspace:*' },
        devDependencies: { '@types/node': '^24.13.6' },
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': `${JSON.stringify(tsconfig, null, 2)}\n`,
    'manifest.ts': `${SPDX}import { defineManifest } from '@socle/framework';

export default defineManifest({
  name: '${name}',
  version: '0.1.0',
  label: { fr: '${title}' },
  depends: [],
  license: 'LGPL-3.0-only',
  edition: 'community',
  engines: { socle: '^${SOCLE_VERSION}' },
});
`,
    'models/item.ts': `${SPDX}import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: '${model}',
  fields: {
    name: f.char({ required: true }),
    notes: f.text(),
  },
});
`,
    'security/groups.ts': `${SPDX}import type { GroupDefinition } from '@socle/framework';

export default [
  { id: '${name}.group_user', name: { fr: 'Utilisateur ${title}' } },
] satisfies GroupDefinition[];
`,
    'security/access.ts': `${SPDX}import type { AccessDefinition } from '@socle/framework';

export default [
  {
    model: '${model}',
    group: '${name}.group_user',
    read: true,
    write: true,
    create: true,
    unlink: true,
  },
] satisfies AccessDefinition[];
`,
    'views/item.views.ts': `${SPDX}import { defineView, field, form, group, list } from '@socle/framework';

export default [
  defineView({
    id: '${model}.form',
    model: '${model}',
    type: 'form',
    arch: form([group([field('name'), field('notes')])]),
  }),
  defineView({ id: '${model}.list', model: '${model}', type: 'list', arch: list([field('name')]) }),
];
`,
    'tests/module.test.ts': `${SPDX}import { buildModelRegistry, buildSecurityPolicy, buildViewRegistry } from '@socle/framework';
import { describe, expect, it } from 'vitest';

import manifest from '../manifest.js';
import item from '../models/item.js';
import access from '../security/access.js';
import groups from '../security/groups.js';
import views from '../views/item.views.js';

describe('${name}', () => {
  it('builds its registry, security policy and views', () => {
    const registry = buildModelRegistry([{ module: manifest.name, models: [item] }], {
      side: 'server',
    });
    expect(registry.has('${model}')).toBe(true);
    buildSecurityPolicy([{ module: manifest.name, groups, access }], (m) => registry.has(m));
    buildViewRegistry([{ module: manifest.name, views }], registry);
  });
});
`,
  };
}

/**
 * Creates `<dir>/<name>/` with a module skeleton; refuses an invalid name or an existing
 * directory. Returns the created files, relative to the module directory.
 */
export async function scaffoldModule(name: string, dir: string): Promise<string[]> {
  // The name rules are those of the manifest: validate it through the framework itself.
  try {
    parseManifest({
      name,
      version: '0.1.0',
      label: { fr: name },
      license: 'LGPL-3.0-only',
      edition: 'community',
      engines: { socle: `^${SOCLE_VERSION}` },
    });
  } catch (error) {
    throw new ScaffoldError(
      `Invalid module name "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = resolve(dir);
  // The validated name has no separator nor dot: the module stays inside `root`.
  const target = join(root, name);
  if (existsSync(target)) throw new ScaffoldError(`${target} already exists.`);

  const content = files(name, baseConfig(root, target));
  await mkdir(target, { recursive: true });
  for (const [file, text] of Object.entries(content)) {
    const path = join(target, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { flag: 'wx' });
  }
  return Object.keys(content);
}
