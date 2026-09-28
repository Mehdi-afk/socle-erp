// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { InvalidManifestError } from './errors.js';
import { defineManifest, parseManifest, type ManifestInput } from './manifest.js';

const valid: ManifestInput = {
  name: 'sale',
  version: '1.0.0',
  label: { fr: 'Ventes', en: 'Sales', ar: 'المبيعات' },
  depends: ['base', 'contacts'],
  license: 'LGPL-3.0-only',
  edition: 'community',
  engines: { socle: '^0.1' },
};

describe('defineManifest', () => {
  it('applies defaults', () => {
    const manifest = defineManifest(valid);
    expect(manifest.application).toBe(false);
    expect(manifest.autoInstall).toBe(false);
    expect(manifest.offline).toEqual({ syncable: true });
    expect(manifest.capabilities).toEqual([]);
  });

  it('returns a deeply frozen object', () => {
    const manifest = defineManifest({ ...valid, capabilities: [{ network: ['api.exemple.fr'] }] });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.depends)).toBe(true);
    expect(Object.isFrozen(manifest.capabilities[0])).toBe(true);
  });

  it('accepts every capability kind', () => {
    const manifest = defineManifest({
      ...valid,
      capabilities: ['sudo', 'cron', 'files', { network: ['api.exemple.fr', 'chorus.gouv.fr'] }],
    });
    expect(manifest.capabilities).toHaveLength(4);
  });

  it.each([
    ['uppercase name', { name: 'Sale' }],
    ['name with a dash', { name: 'sale-margin' }],
    ['invalid version', { version: '1.0' }],
    ['invalid engine range', { engines: { socle: 'not a range' } }],
    ['self dependency', { depends: ['sale'] }],
    ['duplicate dependency', { depends: ['base', 'base'] }],
    ['unknown edition', { edition: 'enterprise' }],
    ['missing French label', { label: { en: 'Sales' } }],
    ['unknown key', { price: 10 }],
    ['network capability with a scheme', { capabilities: [{ network: ['https://evil.example'] }] }],
    ['network capability with a wildcard', { capabilities: [{ network: ['*.example.fr'] }] }],
    ['network capability with uppercase', { capabilities: [{ network: ['API.exemple.fr'] }] }],
    ['network capability without a domain', { capabilities: [{ network: ['localhost'] }] }],
    ['network label starting with a dash', { capabilities: [{ network: ['-api.exemple.fr'] }] }],
    ['unknown capability', { capabilities: ['root'] }],
    ['license with spaces', { license: 'MIT OR GPL' }],
  ])('rejects %s', (_case, override) => {
    expect(() => parseManifest({ ...valid, ...override })).toThrow(InvalidManifestError);
  });

  it('reports every issue with its path', () => {
    try {
      parseManifest({ ...valid, version: 'x', edition: 'enterprise' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidManifestError);
      const issues = (error as InvalidManifestError).issues.join('\n');
      expect(issues).toContain('version');
      expect(issues).toContain('edition');
    }
  });

  it('rejects a non-object value', () => {
    expect(() => parseManifest('sale')).toThrow(InvalidManifestError);
  });
});
