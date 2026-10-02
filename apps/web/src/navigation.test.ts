// SPDX-License-Identifier: LGPL-3.0-only
import { hydrateRegistrySnapshot, type ModelSnapshot, type ViewSnapshot } from '@socle/framework';
import { describe, expect, it } from 'vitest';

import { backTo, catalogEntries, navigate, routeView, type WebRoute } from './navigation.js';

const firstId = 'a0000000-0000-4000-8000-000000000001';
const secondId = 'a0000000-0000-4000-8000-000000000002';

function model(name: string, description?: ModelSnapshot['description']): ModelSnapshot {
  return {
    name,
    ...(description === undefined ? {} : { description }),
    permissions: { create: false, write: false, unlink: false },
    fields: [{ name: 'id', type: 'char', required: true, readonly: true, stored: true }],
    order: [{ field: 'id', direction: 'asc' }],
  };
}

function view(name: string, type: 'list' | 'form', priority = 16): ViewSnapshot {
  return {
    id: `${name}_${type}_${String(priority)}`,
    model: name,
    type,
    priority,
    arch: { type, attrs: {}, children: [{ type: 'field', attrs: { name: 'id' }, children: [] }] },
  };
}

function catalog() {
  return hydrateRegistrySnapshot({
    version: 1,
    userId: 'alice',
    companyId: null,
    models: [
      model('test.zeta', { fr: 'Même nom', en: 'Same name' }),
      model('test.alpha', { fr: 'Même nom', en: 'Same name' }),
      model('test.orders', { fr: 'Commandes', en: 'Orders', ar: 'طلبات' }),
      model('test.partners', { fr: 'Partenaires', en: 'Accounts', ar: 'حسابات' }),
      model('test.archived'),
      model('test.hidden'),
      model('test.abstract'),
    ],
    views: [
      view('test.zeta', 'list'),
      view('test.alpha', 'list'),
      view('test.orders', 'list'),
      view('test.orders', 'form'),
      view('test.partners', 'list'),
      view('test.partners', 'list', 8),
      view('test.partners', 'form'),
      view('test.archived', 'list'),
      view('test.hidden', 'form'),
      view('test.abstract', 'list'),
    ],
  });
}

describe('catalogue navigation', () => {
  it('uses default views, excludes abstract or listless models, and permits list-only entries', () => {
    const client = catalog();
    const original = client.registry;
    const entries = catalogEntries(
      {
        views: client.views,
        registry: {
          ...original,
          get: (name) => ({ ...original.get(name), abstract: name === 'test.abstract' }),
        },
      },
      'fr',
    );
    expect(entries.map((entry) => entry.model)).toEqual([
      'test.orders',
      'test.alpha',
      'test.zeta',
      'test.partners',
      'test.archived',
    ]);
    expect(entries.find((entry) => entry.model === 'test.partners')?.list.priority).toBe(8);
    expect(entries.find((entry) => entry.model === 'test.archived')).toMatchObject({
      label: 'Test.archived',
    });
    expect(entries.find((entry) => entry.model === 'test.archived')).not.toHaveProperty('form');
  });

  it('sorts translated labels for FR, EN and regional AR, with deterministic model-name ties', () => {
    const client = catalog();
    const translated = (language: string) =>
      catalogEntries(client, language)
        .filter((entry) => ['test.orders', 'test.partners'].includes(entry.model))
        .map((entry) => entry.label);
    expect(translated('fr')).toEqual(['Commandes', 'Partenaires']);
    expect(translated('en')).toEqual(['Accounts', 'Orders']);
    expect(translated('ar-DZ')).toEqual(['حسابات', 'طلبات']);
    expect(
      catalogEntries(client, 'en')
        .filter((entry) => entry.label === 'Same name')
        .map((entry) => entry.model),
    ).toEqual(['test.alpha', 'test.zeta']);
  });

  it('accepts an empty catalogue without inventing navigation entries', () => {
    const client = hydrateRegistrySnapshot({
      version: 1,
      userId: 'alice',
      companyId: null,
      models: [],
      views: [],
    });
    expect(catalogEntries(client, 'fr')).toEqual([]);
    expect(routeView([], { model: 'test.orders' })).toBeUndefined();
  });

  it('resolves known lists and forms but refuses unknown models, missing forms and invalid IDs', () => {
    const entries = catalogEntries(catalog(), 'fr');
    expect(routeView(entries, { model: 'test.orders' })?.type).toBe('list');
    expect(routeView(entries, { model: 'test.orders', id: firstId })?.type).toBe('form');
    expect(routeView(entries, { model: 'test.orders', id: firstId.toUpperCase() })?.type).toBe(
      'form',
    );
    expect(routeView(entries, { model: 'test.archived', id: firstId })).toBeUndefined();
    expect(routeView(entries, { model: 'test.unknown', id: firstId })).toBeUndefined();
    expect(routeView(entries, { model: 'test.hidden' })).toBeUndefined();
    for (const id of ['', '1', '../../record', `${firstId}/edit`, `${firstId} `]) {
      expect(routeView(entries, { model: 'test.orders', id })).toBeUndefined();
    }
  });
});

describe('in-memory breadcrumb stack', () => {
  it('appends related records, avoids a duplicate current destination, and does not mutate its input', () => {
    const list: WebRoute = { model: 'test.orders' };
    const order: WebRoute = { model: 'test.orders', id: firstId };
    const related: WebRoute = { model: 'test.partners', id: secondId };
    const initial: readonly WebRoute[] = Object.freeze([list]);
    const opened = navigate(initial, order);
    const details = navigate(opened, related);
    expect(initial).toEqual([list]);
    expect(details).toEqual([list, order, related]);
    expect(navigate(details, { ...related })).toBe(details);
    expect(navigate(details, { model: 'test.orders', id: secondId })).toHaveLength(4);
    expect(navigate(details, list)).toEqual([list, order, related, list]);
    expect(navigate([], list)).toEqual([list]);
  });

  it('returns to a breadcrumb and leaves invalid indices unchanged', () => {
    const stack: readonly WebRoute[] = Object.freeze([
      { model: 'test.orders' },
      { model: 'test.orders', id: firstId },
      { model: 'test.partners', id: secondId },
    ]);
    expect(backTo(stack, 0)).toEqual([stack[0]]);
    expect(backTo(stack, 1)).toEqual([stack[0], stack[1]]);
    expect(stack).toHaveLength(3);
    for (const index of [-1, 2, 3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(backTo(stack, index)).toBe(stack);
    }
    expect(backTo([], 0)).toEqual([]);
  });
});
