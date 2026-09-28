// SPDX-License-Identifier: LGPL-3.0-only
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCatalog, type DiscoveredModule } from './catalog.js';
import {
  DependencyCycleError,
  DuplicateModuleError,
  IncompatibleEngineError,
  MissingDependencyError,
  ModuleLocationError,
  UnknownModuleError,
} from './errors.js';
import { resolveInstallation, topologicalOrder } from './resolve.js';

function mod(
  name: string,
  depends: string[] = [],
  extra: Record<string, unknown> = {},
): DiscoveredModule {
  return {
    directory: name,
    manifest: {
      name,
      version: '1.0.0',
      label: { fr: name },
      depends,
      license: 'LGPL-3.0-only',
      edition: 'community',
      engines: { socle: '^0.1' },
      ...extra,
    },
  };
}

describe('createCatalog', () => {
  it('indexes valid modules', () => {
    const catalog = createCatalog([mod('base'), mod('contacts', ['base'])]);
    expect(catalog.names()).toEqual(['base', 'contacts']);
    expect(catalog.get('contacts').depends).toEqual(['base']);
    expect(catalog.has('sale')).toBe(false);
  });

  it('rejects a duplicate module', () => {
    expect(() => createCatalog([mod('base'), mod('base')])).toThrow(DuplicateModuleError);
  });

  it('rejects a module whose directory does not match its name', () => {
    expect(() => createCatalog([{ ...mod('base'), directory: 'core' }])).toThrow(
      ModuleLocationError,
    );
  });

  it('rejects a missing dependency', () => {
    expect(() => createCatalog([mod('sale', ['base'])])).toThrow(MissingDependencyError);
  });

  it('rejects a dependency cycle and reports it', () => {
    try {
      createCatalog([mod('m_a', ['m_b']), mod('m_b', ['m_c']), mod('m_c', ['m_a'])]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as DependencyCycleError).cycle).toEqual(['m_a', 'm_b', 'm_c', 'm_a']);
    }
  });

  it('rejects a module requiring another core version', () => {
    expect(() => createCatalog([mod('base', [], { engines: { socle: '^2.0' } })])).toThrow(
      IncompatibleEngineError,
    );
  });

  it('checks engines against the given core version', () => {
    const modules = [mod('base', [], { engines: { socle: '^1.2' } })];
    expect(() => createCatalog(modules, { coreVersion: '1.1.0' })).toThrow(IncompatibleEngineError);
    expect(createCatalog(modules, { coreVersion: '1.4.2' }).has('base')).toBe(true);
  });

  it('throws on an unknown module', () => {
    expect(() => createCatalog([mod('base')]).get('sale')).toThrow(UnknownModuleError);
  });
});

describe('resolveInstallation', () => {
  const catalog = createCatalog([
    mod('base'),
    mod('contacts', ['base']),
    mod('product', ['base']),
    mod('sale', ['contacts', 'product']),
    mod('stock', ['product']),
    mod('sale_stock', ['sale', 'stock'], { autoInstall: true }),
    mod('l10n_fr', ['base']),
  ]);

  it('adds transitive dependencies in dependency order', () => {
    expect(resolveInstallation(catalog, ['sale'])).toEqual(['base', 'contacts', 'product', 'sale']);
  });

  it('installs a bridge module once all its dependencies are present', () => {
    expect(resolveInstallation(catalog, ['stock'], ['sale'])).toEqual([
      'base',
      'contacts',
      'product',
      'sale',
      'stock',
      'sale_stock',
    ]);
  });

  it('does not install a bridge module while a dependency is missing', () => {
    expect(resolveInstallation(catalog, ['sale'])).not.toContain('sale_stock');
  });

  it('rejects an unknown module', () => {
    expect(() => resolveInstallation(catalog, ['hr'])).toThrow(UnknownModuleError);
  });

  it('keeps already installed modules', () => {
    expect(resolveInstallation(catalog, ['l10n_fr'], ['contacts'])).toEqual([
      'base',
      'contacts',
      'l10n_fr',
    ]);
  });
});

describe('topologicalOrder (properties)', () => {
  /** Random acyclic graphs: module i may only depend on modules j < i. */
  const acyclicGraph = fc
    .integer({ min: 1, max: 12 })
    .chain((size) =>
      fc.tuple(
        ...Array.from({ length: size }, (_, i) =>
          fc.subarray(Array.from({ length: i }, (_, j) => j)),
        ),
      ),
    );

  it('puts every module after its dependencies, whatever the input order', () => {
    fc.assert(
      fc.property(acyclicGraph, fc.boolean(), (graph, reverse) => {
        const modules = graph.map((deps, i) =>
          mod(
            `m${String(i)}`,
            deps.map((j) => `m${String(j)}`),
          ),
        );
        const catalog = createCatalog(reverse ? [...modules].reverse() : modules);
        const order = topologicalOrder(catalog, catalog.names());
        expect(order).toHaveLength(graph.length);
        const position = new Map(order.map((name, index) => [name, index]));
        graph.forEach((deps, i) => {
          for (const j of deps) {
            expect(position.get(`m${String(j)}`)).toBeLessThan(position.get(`m${String(i)}`) ?? -1);
          }
        });
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(acyclicGraph, (graph) => {
        const modules = graph.map((deps, i) =>
          mod(
            `m${String(i)}`,
            deps.map((j) => `m${String(j)}`),
          ),
        );
        const a = topologicalOrder(
          createCatalog(modules),
          modules.map((m) => m.directory),
        );
        const b = topologicalOrder(
          createCatalog([...modules].reverse()),
          modules.map((m) => m.directory),
        );
        expect(a).toEqual(b);
      }),
    );
  });
});
