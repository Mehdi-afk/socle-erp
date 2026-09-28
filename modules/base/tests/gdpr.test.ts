// SPDX-License-Identifier: LGPL-3.0-only
import {
  buildModelRegistry,
  createEnvironment,
  createMemoryStorage,
  defineModel,
  f,
  ModelDefinitionError,
  ValidationError,
  type Environment,
  type ModelDefinition,
} from '@socle/framework';
import { describe, expect, it } from 'vitest';

import { retentionStart } from '../lib/gdpr.js';
import companyScoped from '../models/company-scoped.js';
import company from '../models/res-company.js';
import countries from '../models/res-country.js';
import currencies from '../models/res-currency.js';
import groupsModel from '../models/res-groups.js';
import partner from '../models/res-partner.js';
import users from '../models/res-users.js';

// Two models of another module: an invoice kept 10 years by law, a note kept by nobody.
const invoice = defineModel({
  name: 'gdpr.invoice',
  retention: {
    reason: { fr: 'Code de commerce, art. L123-22 : 10 ans', en: 'Commercial code: 10 years' },
    years: 10,
    dateField: 'date',
  },
  fields: { partnerId: f.many2one('res.partner'), date: f.date(), total: f.monetary() },
});
const note = defineModel({
  name: 'gdpr.note',
  fields: { partnerId: f.many2one('res.partner'), body: f.text() },
});

const models: ModelDefinition[] = [
  companyScoped,
  company,
  partner,
  users,
  groupsModel,
  ...currencies,
  ...countries,
  invoice,
  note,
];

interface Gdpr {
  gdprExport(): Promise<{ partner: Record<string, unknown>; related: Record<string, unknown[]> }>;
  gdprAnonymize(): Promise<{ anonymized: true }>;
}

async function fixture(invoiceDate: string): Promise<{ env: Environment; id: string; c1: string }> {
  const registry = buildModelRegistry(
    [
      { module: 'base', models },
      { module: 'gdpr', models: [] },
    ],
    { side: 'server' },
  );
  const env = createEnvironment({
    registry,
    storage: createMemoryStorage(registry),
    user: { id: 'dpo', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
    access: { checkModel: () => undefined, ruleDomain: () => ({ kind: 'true' }) },
    audit: { record: () => undefined },
  });
  const eur = await env.model('res.currency').create({ code: 'EUR', decimals: 2 });
  const france = await env.model('res.country').create({ code: 'FR', name: 'France' });
  const c1 = await env.model('res.company').create({ name: 'Acme', currencyId: eur.id });
  const person = await env.model('res.partner').create({
    name: 'Jeanne Martin',
    email: 'jeanne@example.fr',
    phone: '+33 6 00 00 00 00',
    street: '1 rue de la Paix',
    city: 'Paris',
    countryId: france.id,
    companyId: c1.id,
  });
  await env.model('gdpr.invoice').create({ partnerId: person.id, date: invoiceDate, total: 1200 });
  await env.model('gdpr.note').create({ partnerId: person.id, body: 'Prefers phone calls' });
  return { env, id: person.id, c1: c1.id };
}

const today = new Date().toISOString().slice(0, 10);

describe('GDPR tools', () => {
  it('export the person and every record that refers to them', async () => {
    const { env, id } = await fixture(today);
    const data = await (env.model('res.partner').browse([id]) as unknown as Gdpr).gdprExport();
    expect(data.partner).toMatchObject({ name: 'Jeanne Martin', email: 'jeanne@example.fr' });
    expect(Object.keys(data.related).sort()).toEqual([
      'gdpr.invoice.partnerId',
      'gdpr.note.partnerId',
    ]);
    expect(data.related['gdpr.note.partnerId']).toMatchObject([{ body: 'Prefers phone calls' }]);
  });

  it('refuse to anonymise while a legal retention runs, and say why', async () => {
    const { env, id } = await fixture(today);
    const person = env.model('res.partner').browse([id]) as unknown as Gdpr;
    await expect(person.gdprAnonymize()).rejects.toThrow(ValidationError);
    await expect(person.gdprAnonymize()).rejects.toThrow(/Code de commerce, art. L123-22/);
  });

  it('erase the identifying data once the retention is over, keeping the company', async () => {
    const { env, id, c1 } = await fixture('2010-01-15');
    const record = env.model('res.partner').browse([id]);
    expect(await (record as unknown as Gdpr).gdprAnonymize()).toEqual({ anonymized: true });
    const [values] = await record.read([
      'name',
      'email',
      'phone',
      'street',
      'city',
      'countryId',
      'companyId',
      'active',
      'kind',
    ]);
    expect(values).toEqual({
      name: 'Anonymisé',
      email: null,
      phone: null,
      street: null,
      city: null,
      countryId: null,
      companyId: c1,
      active: false,
      kind: 'person',
    });
  });

  it('refuse to anonymise a person who is a user of the system', async () => {
    const { env, id, c1 } = await fixture('2010-01-15');
    await env.model('res.users').create({ partnerId: id, login: 'jeanne', companyId: c1 });
    await expect(
      (env.model('res.partner').browse([id]) as unknown as Gdpr).gdprAnonymize(),
    ).rejects.toThrow(/is a user/);
  });

  it('computes the start of a retention and validates its declaration', () => {
    expect(retentionStart(new Date('2026-09-28T12:00:00Z'), 10)).toBe('2016-09-28');
    expect(() =>
      buildModelRegistry(
        [
          {
            module: 'x',
            models: [
              defineModel({
                name: 'x.doc',
                retention: { reason: { fr: 'x' }, years: 10 },
                fields: { name: f.char() },
              }),
            ],
          },
        ],
        { side: 'server' },
      ),
    ).toThrow(ModelDefinitionError);
  });
});
