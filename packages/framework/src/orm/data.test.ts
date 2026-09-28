// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { defineData, isExternalId, isExternalRef, ref } from './data.js';
import { ModelDefinitionError } from './model.js';

describe('module data', () => {
  it('declares records with local ids and references by external id', () => {
    const data = defineData('res.country', [
      { id: 'fr', values: { name: 'France', currencyId: ref('base.eur') } },
    ]);
    expect(data).toMatchObject({ kind: 'data', model: 'res.country', noupdate: false });
    expect(isExternalRef(data.records[0]?.values.currencyId)).toBe(true);
    expect(defineData('res.company', [], { noupdate: true }).noupdate).toBe(true);
    expect(Object.isFrozen(data.records[0])).toBe(true);
  });

  it('refuses malformed or duplicate ids and references', () => {
    for (const id of ['FR', 'a-b', '1x', '', 'x'.repeat(129)]) {
      expect(() => defineData('m.x', [{ id, values: {} }]), id).toThrow(ModelDefinitionError);
    }
    expect(() =>
      defineData('m.x', [
        { id: 'a', values: {} },
        { id: 'a', values: {} },
      ]),
    ).toThrow(/declared twice/);
    for (const bad of ['fr', 'base.', '.fr', 'base.fr.x', 'Base.fr']) {
      expect(isExternalId(bad), bad).toBe(false);
      expect(() => ref(bad)).toThrow(ModelDefinitionError);
    }
    expect(isExternalRef({ $ref: 'base.fr', other: 1 })).toBe(false);
    expect(isExternalRef(['base.fr'])).toBe(false);
  });
});
