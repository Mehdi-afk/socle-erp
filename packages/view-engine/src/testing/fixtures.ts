// SPDX-License-Identifier: LGPL-3.0-only
//
// Models and records for the tests of the engine: a contact, its country and a currency, shaped like
// the models of the `base` module but declared here, so that the engine is tested on its own.
import {
  buildModelRegistry,
  defineModel,
  f,
  form,
  group,
  field,
  list,
  notebook,
  page,
  type ModelRegistry,
} from '@socle/framework';

import { createMemoryDataSource, type MemoryDataSource } from '../memory-data-source.js';
import type { RecordValues, ViewContext } from '../types.js';

const country = defineModel({
  name: 'res.country',
  fields: { name: f.char({ required: true }), code: f.char() },
});

const currency = defineModel({
  name: 'res.currency',
  fields: { code: f.char({ required: true }), decimals: f.integer({ default: 2 }) },
});

const partner = defineModel({
  name: 'res.partner',
  fields: {
    name: f.char({ required: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    kind: f.selection(
      [
        ['person', 'Personne'],
        ['company', 'Société'],
      ],
      { default: 'person', label: { fr: 'Type', en: 'Type', ar: 'النوع' } },
    ),
    email: f.char({ label: { fr: 'E-mail', en: 'Email', ar: 'البريد' } }),
    phone: f.char({ label: { fr: 'Téléphone', en: 'Phone', ar: 'الهاتف' } }),
    website: f.char(),
    city: f.char({ label: { fr: 'Ville', en: 'City', ar: 'المدينة' } }),
    countryId: f.many2one('res.country', { label: { fr: 'Pays', en: 'Country', ar: 'البلد' } }),
    currencyId: f.many2one('res.currency'),
    revenue: f.monetary({ label: { fr: 'Chiffre d’affaires', en: 'Revenue' } }),
    subscribed: f.boolean({ label: { fr: 'Abonné', en: 'Subscribed' } }),
    lastContact: f.datetime({ label: { fr: 'Dernier contact', en: 'Last contact' } }),
    vat: f.char({ sensitive: true, label: { fr: 'Identifiant fiscal', en: 'Tax id' } }),
    notes: f.text({ label: { fr: 'Notes', en: 'Notes' } }),
    // Computed, not stored: the database cannot sort on it.
    displayLabel: f.char({ compute: 'computeLabel', depends: ['name'] }),
  },
  methods: (Base) =>
    class extends Base {
      computeLabel(): void {
        /* computed by the server: the view only needs to know the field is not stored */
      }
    },
});

export const registry: ModelRegistry = buildModelRegistry(
  [{ module: 'test', models: [country, currency, partner] }],
  { side: 'client' },
);

export const listArch = list([
  field('name', { widget: 'avatar' }),
  field('email', { widget: 'email' }),
  field('phone', { widget: 'phone' }),
  field('city'),
  field('countryId'),
  field('kind', { widget: 'status_badge', tones: { company: 'info', person: 'neutral' } }),
  field('revenue'),
  field('subscribed'),
  field('displayLabel'),
]);

export const formArch = form([
  group({ name: 'main' }, [field('name'), field('kind'), field('email'), field('phone')]),
  notebook([
    page('address', { fr: 'Adresse', en: 'Address' }, [
      group({ name: 'address' }, [field('city'), field('countryId')]),
    ]),
    page('notes', { fr: 'Notes', en: 'Notes' }, [field('notes')]),
  ]),
]);

const COUNTRIES: RecordValues[] = [
  { id: 'c-dz', name: 'Algérie', code: 'DZ' },
  { id: 'c-fr', name: 'France', code: 'FR' },
  { id: 'c-tn', name: 'Tunisie', code: 'TN' },
];

const CURRENCIES: RecordValues[] = [
  { id: 'cur-dzd', code: 'DZD', decimals: 2 },
  { id: 'cur-eur', code: 'EUR', decimals: 2 },
];

const FIRST = [
  'Amel',
  'Karim',
  'Sara',
  'Yacine',
  'Lina',
  'Omar',
  'Nadia',
  'Rachid',
  'Meriem',
  'Sofiane',
];
const LAST = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Cherif', 'Saidi', 'Boudiaf', 'Zerrouki'];

/** `count` contacts with predictable names (`Amel Benali 0`, `Karim Haddad 1`…). */
export function contacts(count: number): RecordValues[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p-${String(index)}`,
    name: `${FIRST[index % FIRST.length] ?? ''} ${LAST[index % LAST.length] ?? ''} ${String(index)}`,
    kind: index % 4 === 0 ? 'company' : 'person',
    email: `contact${String(index)}@example.test`,
    phone: `0555 12 34 ${String(index % 100).padStart(2, '0')}`,
    city: index % 3 === 0 ? null : ['Alger', 'Oran', 'Constantine'][index % 3],
    countryId: COUNTRIES[index % COUNTRIES.length]?.id,
    currencyId: index % 2 === 0 ? 'cur-dzd' : 'cur-eur',
    revenue: 100_000 + index * 100,
    subscribed: index % 2 === 0,
    lastContact: '2026-03-01T09:30:00.000Z',
    vat: `000${String(index).padStart(9, '0')}`,
    notes: null,
    displayLabel: null,
  }));
}

export interface Fixture {
  readonly data: MemoryDataSource;
  readonly context: ViewContext;
}

export function fixture(count: number, overrides: Partial<ViewContext> = {}, delayMs = 0): Fixture {
  const data = createMemoryDataSource(
    {
      'res.partner': contacts(count),
      'res.country': COUNTRIES,
      'res.currency': CURRENCIES,
    },
    { delayMs },
  );
  return {
    data,
    context: {
      registry,
      data,
      language: 'fr',
      timeZone: 'Africa/Algiers',
      density: 'comfortable',
      ...overrides,
    },
  };
}
