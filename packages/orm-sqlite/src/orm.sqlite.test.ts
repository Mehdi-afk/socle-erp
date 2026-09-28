// SPDX-License-Identifier: LGPL-3.0-only
//
// The ORM offline, on the client's SQLite replica, and the local schema.
import {
  buildModelRegistry,
  createEnvironment,
  defineModel,
  extendModel,
  f,
  ValidationError,
  type FieldsOf,
  type ModelDefinition,
  type ModelExtension,
  type ModelRegistry,
  type ServerCall,
} from '@socle/framework';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { createSqliteDatabase } from './driver.js';
import { registerFunctions } from './functions.js';
import { openNodeSqlite } from './node.js';
import { applyLocalSchema } from './schema.js';
import { createSqliteStorage } from './storage.js';
import { localDatabase } from './test-support.js';

const partner = defineModel({
  name: 'off.partner',
  fields: {
    name: f.char({ required: true }),
    email: f.char(),
    vip: f.boolean(),
    tagIds: f.many2many('off.tag'),
  },
  unique: [{ name: 'email_uniq', fields: ['email'] }],
});
const tag = defineModel({ name: 'off.tag', fields: { name: f.char() } });
const order = defineModel({
  name: 'off.order',
  fields: {
    name: f.char({ required: true }),
    partnerId: f.many2one('off.partner', { ondelete: 'restrict' }),
    lines: f.one2many('off.line', 'orderId'),
    total: f.monetary({ compute: 'computeTotal', store: true, depends: ['lines.amount'] }),
  },
  methods: (Base) =>
    class extends Base {
      computeTotal(): void {
        for (const o of this) o.total = [...o.lines].reduce((sum, line) => sum + line.amount, 0);
      }
    },
  serverMethods: (Base) =>
    class extends Base {
      actionConfirm(): void {
        /* legal numbering: server only */
      }
    },
});
const line = defineModel({
  name: 'off.line',
  fields: {
    orderId: f.many2one('off.order', { required: true, ondelete: 'cascade' }),
    amount: f.monetary(),
  },
});

declare module '@socle/framework' {
  interface ModelFields {
    'off.order': FieldsOf<typeof order>;
    'off.line': FieldsOf<typeof line>;
    'off.partner': FieldsOf<typeof partner>;
  }
}

const clientRegistry = (...models: (ModelDefinition | ModelExtension)[]): ModelRegistry =>
  buildModelRegistry([{ module: 'off', models }], { side: 'client' });

describe('ORM offline on SQLite', () => {
  it('creates, computes, searches, writes, deletes and queues server methods', async () => {
    const registry = clientRegistry(partner, tag, order, line);
    const db = await localDatabase(registry);
    const queued: ServerCall[] = [];
    const env = createEnvironment({
      registry,
      storage: createSqliteStorage(db, registry),
      user: {
        id: 'u1',
        groupIds: [],
        companyIds: [],
        companyId: null,
        lang: 'fr',
        tz: 'UTC',
        deviceId: 'd1',
      },
      access: { checkModel: () => undefined, ruleDomain: () => ({ kind: 'true' }) },
      audit: { record: () => undefined },
      queueServerCall: (call) => {
        queued.push(call);
        return Promise.resolve(undefined);
      },
    });

    const [red] = [...(await env.model('off.tag').create([{ name: 'red' }]))];
    const acme = await env
      .model('off.partner')
      .create({ name: 'Acme', email: 'a@acme.fr', vip: true, tagIds: [red?.id] });
    const so = await env
      .model('off.order')
      .create({ name: 'SO1', partnerId: acme.id, lines: [{ amount: 700 }, { amount: 300 }] });
    expect(so.total).toBe(1000);
    expect(await env.model('off.order').searchCount([['partnerId.tagIds.name', '=', 'red']])).toBe(
      1,
    );
    expect(await env.model('off.partner').searchCount([['vip', '=', true]])).toBe(1);

    const [first] = [...so.lines];
    await first?.write({ amount: 1 });
    const stored = await sql<{
      total: number;
      origin_device: string;
    }>`select total, origin_device from off_order`.execute(db);
    expect(stored.rows).toEqual([{ total: 301, origin_device: 'd1' }]);

    // Server methods are queued as intents offline, never run locally.
    await (so as unknown as { actionConfirm(): Promise<unknown> }).actionConfirm();
    expect(queued).toEqual([
      { model: 'off.order', method: 'actionConfirm', ids: [so.id], args: [] },
    ]);

    await expect(
      env.model('off.partner').create({ name: 'Dup', email: 'a@acme.fr' }),
    ).rejects.toThrow(ValidationError);
    await expect(acme.unlink()).rejects.toThrow(ValidationError);
    await so.unlink();
    expect(await env.model('off.line').searchCount([])).toBe(0);
    await acme.unlink();
    const links = await sql<{
      n: number;
    }>`select count(*) as n from off_partner_tag_ids_rel`.execute(db);
    expect(links.rows[0]?.n).toBe(0);
  });
});

describe('local schema', () => {
  it('adds new fields in place and keeps the rows', async () => {
    const connection = openNodeSqlite();
    registerFunctions(connection);
    const db = createSqliteDatabase(connection);
    expect((await applyLocalSchema(db, clientRegistry(tag))).created).toEqual(['off_tag']);
    await sql`insert into off_tag (id, name) values ('0190a000-0000-7000-8000-000000000001', 'kept')`.execute(
      db,
    );
    const extension = extendModel('off.tag', {
      fields: { color: f.integer(), hidden: f.boolean(), code: f.char() },
    });
    const result = await applyLocalSchema(db, clientRegistry(tag, extension));
    expect(result).toEqual({
      created: [],
      altered: ['off_tag.color', 'off_tag.hidden', 'off_tag.code'],
      reset: false,
    });
    const rows = await sql`select name, color, hidden, code from off_tag`.execute(db);
    expect(rows.rows).toEqual([{ name: 'kept', color: 0, hidden: 0, code: null }]);
    // Nothing to do the second time.
    expect(await applyLocalSchema(db, clientRegistry(tag, extension))).toEqual({
      created: [],
      altered: [],
      reset: false,
    });
  });

  it('rebuilds the replica on an incompatible change (the synchronisation refills it)', async () => {
    const connection = openNodeSqlite();
    registerFunctions(connection);
    const db = createSqliteDatabase(connection);
    await applyLocalSchema(db, clientRegistry(tag));
    await sql`insert into off_tag (id, name) values ('0190a000-0000-7000-8000-000000000001', 'x')`.execute(
      db,
    );
    const retyped = defineModel({ name: 'off.tag', fields: { name: f.integer() } });
    const result = await applyLocalSchema(db, clientRegistry(retyped));
    expect(result.reset).toBe(true);
    expect((await sql`select count(*) as n from off_tag`.execute(db)).rows).toEqual([{ n: 0 }]);
  });
});
