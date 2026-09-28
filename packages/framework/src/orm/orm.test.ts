// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { DomainError, type DomainNode } from './domain.js';
import {
  createEnvironment,
  type AccessControl,
  type AuditEvent,
  type Environment,
  type ServerCall,
} from './environment.js';
import {
  AccessError,
  FieldNotLoadedError,
  RecordsetError,
  ServerOnlyError,
  ValidationError,
} from './errors.js';
import { FieldValueError } from './values.js';
import { f } from './fields.js';
import { createMemoryStorage } from './memory-storage.js';
import {
  defineModel,
  extendModel,
  ModelDefinitionError,
  type RecordsetConstructor,
} from './model.js';
import { buildModelRegistry, type ModuleModels, type RuntimeSide } from './model-registry.js';
import type { Recordset } from './recordset.js';

// ─── typed views used by the test models (point 3 will infer these) ───────────

interface Partner extends Recordset {
  name: string | null;
  email: string | null;
  countryCode: string | null;
}
interface Line extends Recordset {
  orderId: Order;
  qty: number;
  price: number;
  priceSubtotal: number;
}
interface Order extends Recordset {
  name: string;
  state: string;
  partnerId: Partner;
  partnerName: string | null;
  lines: Line;
  amountUntaxed: number;
  lineCount: number;
  margin: number;
  messageCount: number;
  actionConfirm(): Promise<string[]>;
  checkAmount(): void;
}

// Typed view of a record until point 3 infers field types.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const self = <T>(record: unknown): T => record as T;

// ─── modules ───────────────────────────────────────────────────────────────────

const base: ModuleModels = {
  module: 'base',
  models: [
    defineModel({
      name: 'res.partner',
      fields: {
        name: f.char({ required: true }),
        email: f.char(),
        countryCode: f.char({ size: 2 }),
      },
      order: 'name',
      unique: [{ name: 'email_unique', fields: ['email'] }],
    }),
    defineModel({
      name: 'mail.thread',
      abstract: true,
      fields: { messageCount: f.integer({ default: 0 }) },
      methods: (Base) =>
        class extends Base {
          postMessage(): void {
            for (const record of this) self<Order>(record).messageCount = 0;
          }
        },
    }),
  ],
};

const confirmLog: string[] = [];

const sale: ModuleModels = {
  module: 'sale',
  models: [
    defineModel({
      name: 'sale.order',
      mixins: ['mail.thread'],
      fields: {
        name: f.char({ required: true, default: '/' }),
        state: f.selection(
          [
            ['draft', 'Brouillon'],
            ['sale', 'Confirmé'],
          ],
          { default: 'draft' },
        ),
        partnerId: f.many2one('res.partner', { required: true, ondelete: 'restrict' }),
        partnerName: f.char({ related: 'partnerId.name' }),
        lines: f.one2many('sale.order.line', 'orderId'),
        amountUntaxed: f.monetary({
          compute: 'computeAmounts',
          store: true,
          depends: ['lines.priceSubtotal'],
        }),
        lineCount: f.integer({ compute: 'computeLineCount', depends: ['lines'] }),
      },
      constraints: [{ fields: ['amountUntaxed'], check: 'checkAmount' }],
      methods: (Base) =>
        class extends Base {
          computeAmounts(): void {
            for (const record of this) {
              const order = self<Order>(record);
              order.amountUntaxed = [...order.lines].reduce(
                (sum, line) => sum + line.priceSubtotal,
                0,
              );
            }
          }
          computeLineCount(): void {
            for (const record of this)
              self<Order>(record).lineCount = self<Order>(record).lines.length;
          }
          checkAmount(): void {
            for (const record of this) {
              if (self<Order>(record).amountUntaxed > 1_000_000_00)
                throw new ValidationError('Amount too high.');
            }
          }
        },
      serverMethods: (Base) =>
        class extends Base {
          async actionConfirm(): Promise<string[]> {
            confirmLog.push('sale');
            for (const record of this) self<Order>(record).state = 'sale';
            await this.env.flush();
            return confirmLog;
          }
        },
    }),
    defineModel({
      name: 'sale.order.line',
      fields: {
        orderId: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
        qty: f.integer({ default: 1 }),
        price: f.monetary(),
        priceSubtotal: f.monetary({
          compute: 'computeSubtotal',
          store: true,
          depends: ['qty', 'price'],
        }),
      },
      methods: (Base) =>
        class extends Base {
          computeSubtotal(): void {
            for (const record of this) {
              const line = self<Line>(record);
              line.priceSubtotal = line.qty * line.price;
            }
          }
        },
    }),
  ],
};

const saleMargin: ModuleModels = {
  module: 'sale_margin',
  models: [
    extendModel('sale.order', {
      fields: {
        margin: f.monetary({ compute: 'computeMargin', store: true, depends: ['amountUntaxed'] }),
      },
      methods: (Base) =>
        class extends Base {
          computeMargin(): void {
            for (const record of this)
              self<Order>(record).margin = Math.round(self<Order>(record).amountUntaxed * 0.3);
          }
        },
      serverMethods: (Base) =>
        class extends (Base as unknown as new (
          ...args: ConstructorParameters<RecordsetConstructor>
        ) => Order) {
          override async actionConfirm(): Promise<string[]> {
            confirmLog.push('margin:before');
            const result = await super.actionConfirm();
            confirmLog.push('margin:after');
            return result;
          }
        },
    }),
  ],
};

const users: ModuleModels = {
  module: 'users',
  models: [
    defineModel({
      name: 'res.users',
      inherits: { 'res.partner': 'partnerId' },
      fields: { login: f.char({ required: true }) },
    }),
    // Prototype inheritance: a copy of the partner model.
    defineModel({ name: 'res.partner.archive', inherit: 'res.partner' }),
  ],
};

// Loaded after "users": its extension of res.partner must reach res.partner.archive too.
const partnerExtra: ModuleModels = {
  module: 'partner_extra',
  models: [extendModel('res.partner', { fields: { vat: f.char() } })],
};

const allModules = [base, sale, saleMargin, users, partnerExtra];

// ─── helpers ───────────────────────────────────────────────────────────────────

const allowAll: AccessControl = {
  checkModel: () => undefined,
  ruleDomain: () => ({ kind: 'true' }),
};

interface Setup {
  env: Environment;
  /** Another environment on the same storage, with an empty cache (e.g. a new request). */
  fresh: () => Environment;
  audit: AuditEvent[];
  calls: ServerCall[];
}

function setup(
  options: {
    access?: AccessControl;
    side?: RuntimeSide;
    modules?: ModuleModels[];
    queue?: boolean;
  } = {},
): Setup {
  const registry = buildModelRegistry(options.modules ?? allModules, {
    side: options.side ?? 'server',
  });
  const audit: AuditEvent[] = [];
  const calls: ServerCall[] = [];
  const storage = createMemoryStorage(registry);
  const make = (): Environment =>
    createEnvironment({
      registry,
      storage,
      user: {
        id: 'u1',
        groupIds: [],
        companyIds: ['c1'],
        companyId: 'c1',
        lang: 'fr',
        tz: 'Europe/Paris',
      },
      access: options.access ?? allowAll,
      audit: { record: (event) => audit.push(event) },
      queueServerCall:
        options.queue === false
          ? undefined
          : (call) => {
              calls.push(call);
              return Promise.resolve('queued');
            },
    });
  return { env: make(), fresh: make, audit, calls };
}

async function order(
  env: Environment,
  lines: { qty: number; price: number }[] = [],
): Promise<Order> {
  const partner = await env
    .model('res.partner')
    .create({ name: 'Acme', email: `${String(Math.random())}@acme.fr` });
  return self<Order>(await env.model('sale.order').create({ partnerId: partner, lines }));
}

// ─── tests ─────────────────────────────────────────────────────────────────────

describe('model composition', () => {
  it('runs an extension override and the original method through super, in order', async () => {
    const { env } = setup();
    const o = await order(env);
    confirmLog.length = 0;
    await o.actionConfirm();
    expect(confirmLog).toEqual(['margin:before', 'sale', 'margin:after']);
    expect(o.state).toBe('sale');
  });

  it('adds the fields of an extension and of a mixin', () => {
    const { env } = setup();
    const meta = env.registry.get('sale.order');
    expect(meta.fields.has('margin')).toBe(true);
    expect(meta.fields.has('messageCount')).toBe(true);
    expect(meta.modules).toEqual(['sale', 'sale_margin']);
  });

  it('propagates a later extension of a parent model to its prototype children', () => {
    const { env } = setup();
    expect(env.registry.get('res.partner.archive').fields.has('vat')).toBe(true);
    expect(env.registry.get('res.partner.archive').table).toBe('res_partner_archive');
  });

  it.each([
    [
      'a duplicate definition',
      [base, { module: 'x', models: [defineModel({ name: 'res.partner' })] }],
      /extendModel/,
    ],
    [
      'an extension of an unknown model',
      [{ module: 'x', models: [extendModel('hr.employee', {})] }],
      /unknown model/,
    ],
    [
      'incompatible field types',
      [
        base,
        { module: 'x', models: [extendModel('res.partner', { fields: { name: f.integer() } })] },
      ],
      /char.*integer/,
    ],
    [
      'a compute method that is a server method',
      [
        {
          module: 'x',
          models: [
            defineModel({
              name: 'x.a',
              fields: { total: f.integer({ compute: 'computeTotal' }) },
              serverMethods: (Base) =>
                class extends Base {
                  computeTotal(): void {
                    /* server only */
                  }
                },
            }),
          ],
        },
      ],
      /isomorphic/,
    ],
    [
      'a field clashing with the recordset API',
      [{ module: 'x', models: [defineModel({ name: 'x.a', fields: { search: f.char() } })] }],
      /recordset member/,
    ],
    [
      'an unresolvable related path',
      [
        base,
        {
          module: 'x',
          models: [defineModel({ name: 'x.a', fields: { p: f.char({ related: 'nope.name' }) } })],
        },
      ],
      /related path/,
    ],
    [
      'a one2many without inverse',
      [
        base,
        {
          module: 'x',
          models: [defineModel({ name: 'x.a', fields: { ps: f.one2many('res.partner', 'aId') } })],
        },
      ],
      /one2many/,
    ],
    [
      'an inheritance cycle',
      [
        {
          module: 'x',
          models: [
            defineModel({ name: 'x.a', abstract: true, mixins: ['x.b'] }),
            defineModel({ name: 'x.b', abstract: true, mixins: ['x.a'] }),
          ],
        },
      ],
      /cycle/,
    ],
  ])('rejects %s', (_case, modules, message) => {
    expect(() => buildModelRegistry(modules, { side: 'server' })).toThrow(message);
  });

  it('rejects reserved and non camelCase field names', () => {
    expect(() => defineModel({ name: 'x.a', fields: { version: f.integer() } })).toThrow(
      ModelDefinitionError,
    );
    expect(() => defineModel({ name: 'x.a', fields: { first_name: f.char() } })).toThrow(
      ModelDefinitionError,
    );
    expect(() => defineModel({ name: 'X.A' })).toThrow(ModelDefinitionError);
  });
});

describe('create, read, search', () => {
  it('applies defaults, technical fields and returns cached records', async () => {
    const { env } = setup();
    const o = await order(env);
    expect(o.name).toBe('/');
    expect(o.state).toBe('draft');
    expect(o.partnerId.name).toBe('Acme');
    expect(o.partnerName).toBe('Acme');
    const [row] = await o.read(['createdBy', 'version']);
    expect(row).toEqual({ createdBy: 'u1', version: 0 });
  });

  it('searches with domains, relational paths, related fields, order and limit', async () => {
    const { env } = setup();
    const partners = env.model('res.partner');
    await partners.create([
      { name: 'Zed', email: 'z@x.fr', countryCode: 'FR' },
      { name: 'Alpha', email: 'a@x.dz', countryCode: 'DZ' },
      { name: 'Beta', email: 'b@x.dz', countryCode: 'DZ' },
    ]);
    const dz = self<Partner>(await partners.search([['countryCode', '=', 'DZ']]));
    expect([...dz].map((p) => self<Partner>(p).name)).toEqual(['Alpha', 'Beta']);
    expect((await partners.search([], { order: 'name desc', limit: 1 })).length).toBe(1);
    expect(
      await partners.searchCount(['|', ['name', 'ilike', 'alp'], ['email', '=like', '%.fr']]),
    ).toBe(2);

    const alpha = (await partners.search([['name', '=', 'Alpha']])).id;
    await env.model('sale.order').create({ partnerId: alpha });
    const orders = env.model('sale.order');
    expect(await orders.searchCount([['partnerId.countryCode', '=', 'DZ']])).toBe(1);
    expect(await orders.searchCount([['partnerName', '=', 'Alpha']])).toBe(1);
    await expect(orders.search([['lineCount', '>', 0]])).rejects.toThrow(DomainError);
    await expect(orders.search([['secret', '=', 1]])).rejects.toThrow(DomainError);
  });

  it('validates values: money is an integer, unknown fields and required fields are refused', async () => {
    const { env } = setup();
    await expect(env.model('res.partner').create({ name: 'A', unknown: 1 })).rejects.toThrow(
      ValidationError,
    );
    await expect(env.model('res.partner').create({ email: 'x@y.fr' })).rejects.toThrow(/required/);
    const o = await order(env);
    await expect(
      env.model('sale.order.line').create({ orderId: o, qty: 1, price: 12.5 }),
    ).rejects.toThrow(FieldValueError);
  });

  it('enforces uniqueness', async () => {
    const { env } = setup();
    await env.model('res.partner').create({ name: 'A', email: 'same@x.fr' });
    await expect(
      env.model('res.partner').create({ name: 'B', email: 'same@x.fr' }),
    ).rejects.toThrow(/Uniqueness/);
  });

  it('requires a prefetch before reading unloaded relations', async () => {
    const { env, fresh: newEnv } = setup();
    const o = await order(env, [{ qty: 1, price: 100 }]);
    const fresh = self<Order>(createFreshView(newEnv(), o));
    expect(() => fresh.lines).toThrow(FieldNotLoadedError);
    await fresh.prefetch(['lines.price']);
    expect(fresh.lines.length).toBe(1);
    expect(() =>
      [...env.model('sale.order').browse([o.id, o.id + 'x'])].map((r) => self<Order>(r).name),
    ).toThrow();
  });

  it('refuses to read a field on several records', async () => {
    const { env } = setup();
    await env.model('res.partner').create([{ name: 'A' }, { name: 'B' }]);
    const partners = self<Partner>(await env.model('res.partner').search([]));
    expect(() => partners.name).toThrow(RecordsetError);
  });
});

/** Same record in a new environment (empty cache), same storage. */
function createFreshView(env: Environment, record: Recordset): Recordset {
  return env.model(record.model).browse(record.ids);
}

describe('computed fields', () => {
  it('computes stored fields at creation and through dependency chains', async () => {
    const { env } = setup();
    const o = await order(env, [
      { qty: 2, price: 1000 },
      { qty: 1, price: 500 },
    ]);
    expect(o.amountUntaxed).toBe(2500);
    expect(o.margin).toBe(750);
    expect(o.lineCount).toBe(2);
  });

  it('recomputes when a line changes, is deleted, or moves to another order', async () => {
    const { env } = setup();
    const a = await order(env, [
      { qty: 2, price: 1000 },
      { qty: 1, price: 500 },
    ]);
    const b = await order(env);
    const [first, second] = [...a.lines];
    await self<Line>(first).write({ qty: 3 });
    expect(a.amountUntaxed).toBe(3500);

    await self<Line>(second).write({ orderId: b });
    expect(a.amountUntaxed).toBe(3000);
    expect(b.amountUntaxed).toBe(500);

    await self<Line>(first).unlink();
    expect(a.amountUntaxed).toBe(0);
    expect(a.margin).toBe(0);
  });

  it('forbids assigning a computed field outside its compute method', async () => {
    const { env } = setup();
    const o = await order(env);
    expect(() => {
      o.amountUntaxed = 1;
    }).toThrow(RecordsetError);
  });

  it('runs model constraints after writes', async () => {
    const { env } = setup();
    const o = await order(env, [{ qty: 1, price: 100 }]);
    await expect(self<Line>([...o.lines][0]).write({ price: 2_000_000_00 })).rejects.toThrow(
      'Amount too high.',
    );
  });
});

describe('delegation', () => {
  it('creates the parent record, reads and writes its fields through the child', async () => {
    const { env } = setup();
    const user = self<Recordset & { name: string; login: string; partnerId: Partner }>(
      await env.model('res.users').create({ name: 'Mehdi', login: 'mehdi' }),
    );
    expect(user.partnerId.name).toBe('Mehdi');
    expect(user.name).toBe('Mehdi');
    await user.write({ name: 'M. Messaoudene' });
    expect(
      self<Partner>(await env.model('res.partner').search([['id', '=', user.partnerId.id]])).name,
    ).toBe('M. Messaoudene');
  });
});

describe('ondelete', () => {
  it('cascades, restricts and sets null', async () => {
    const { env } = setup({
      modules: [
        ...allModules,
        {
          module: 'x',
          models: [
            defineModel({
              name: 'x.note',
              fields: { orderId: f.many2one('sale.order', { ondelete: 'set null' }) },
            }),
          ],
        },
      ],
    });
    const o = await order(env, [{ qty: 1, price: 1 }]);
    const note = await env.model('x.note').create({ orderId: o });
    await expect(o.partnerId.unlink()).rejects.toThrow(/referenced/);
    await o.unlink();
    expect(await env.model('sale.order.line').searchCount([])).toBe(0);
    expect(
      self<{ orderId: Recordset }>(await env.model('x.note').search([['id', '=', note.id]])).orderId
        .length,
    ).toBe(0);
  });
});

describe('environment', () => {
  it('writes every sudo() to the audit log and requires a reason', () => {
    const { env, audit } = setup();
    const su = env.sudo('recompute legal numbering');
    expect(su.su).toBe(true);
    expect(audit).toEqual([
      {
        type: 'sudo',
        userId: 'u1',
        reason: 'recompute legal numbering',
        at: expect.any(String) as string,
      },
    ]);
    expect(() => env.sudo(' ')).toThrow(RecordsetError);
  });

  it('forbids sudo() on the client', () => {
    const { env } = setup({ side: 'client' });
    expect(() => env.sudo('x')).toThrow(ServerOnlyError);
  });

  it('turns server methods into queued intents on the client', async () => {
    const { env, calls } = setup({ side: 'client' });
    const o = await order(env);
    expect(await o.actionConfirm()).toBe('queued');
    expect(calls).toEqual([
      { model: 'sale.order', method: 'actionConfirm', ids: [o.id], args: [] },
    ]);
    expect(o.state).toBe('draft');
  });

  it('refuses server methods offline without an intent queue', async () => {
    const { env } = setup({ side: 'client', queue: false });
    const o = await order(env);
    await expect(o.actionConfirm()).rejects.toThrow(ServerOnlyError);
  });

  it('cannot be constructed directly', () => {
    const { env } = setup();
    const Ctor = env.constructor as new (...args: unknown[]) => unknown;
    expect(() => new Ctor(Symbol('fake'), {}, {}, true)).toThrow(TypeError);
  });
});

describe('access control hooks', () => {
  const onlyAcme: DomainNode = { kind: 'condition', path: ['name'], operator: '=', value: 'Acme' };
  const restricted: AccessControl = {
    checkModel: (_env, model, operation) => {
      if (model === 'sale.order.line' && operation === 'unlink') throw new AccessError('no');
    },
    ruleDomain: (_env, model) => (model === 'res.partner' ? onlyAcme : { kind: 'true' }),
  };

  it('refuses by model and filters by record rules', async () => {
    const { env } = setup({ access: restricted });
    const o = await order(env, [{ qty: 1, price: 1 }]);
    await expect([...o.lines][0]?.unlink()).rejects.toThrow(AccessError);
    await env.sudo('seed').model('res.partner').create({ name: 'Other' });
    expect(await env.model('res.partner').searchCount([])).toBe(1);
  });

  it('checks writes on records outside the rules, even when flushed from sudo()', async () => {
    const { env } = setup({ access: restricted });
    const other = await env.sudo('seed').model('res.partner').create({ name: 'Other' });
    const mine = env.model('res.partner').browse(other.ids);
    await expect(mine.write({ email: 'x@y.fr' })).rejects.toThrow(AccessError);

    self<Partner>(mine).email = 'x@y.fr';
    await expect(env.sudo('flush').flush()).rejects.toThrow(AccessError);
  });
});
