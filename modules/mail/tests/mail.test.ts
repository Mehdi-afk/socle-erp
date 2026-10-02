// SPDX-License-Identifier: LGPL-3.0-only
import { join } from 'node:path';

import {
  AccessError,
  buildModelRegistry,
  buildSecurityPolicy,
  buildViewRegistry,
  createAccessControl,
  createEnvironment,
  createMemoryStorage,
  defineModel,
  extendModel,
  f,
  MissingRecordError,
  ValidationError,
  type Environment,
  type Recordset,
  type UserContext,
} from '@socle/framework';
import { loadModules } from '@socle/runtime';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  activityStatus,
  finishActivity,
  followThread,
  markNotificationRead,
  postMessage,
  readActivities,
  readNotifications,
  readThread,
  scheduleActivity,
} from '../lib/service.js';

let modules: Awaited<ReturnType<typeof loadModules>>;
beforeAll(async () => {
  modules = await loadModules([join(import.meta.dirname, '..', '..')]);
});

async function fixture(side: 'server' | 'client' = 'server') {
  const loaded = ['base', 'mail'].map((name) => modules.get(name));
  const registry = buildModelRegistry(
    [
      ...loaded.map((module) => module.models),
      {
        module: 'test',
        models: [
          extendModel('res.partner', {
            fields: {
              privateValue: f.char({ tracking: true, groups: ['base.group_system'] }),
              secretValue: f.char({ tracking: true, sensitive: true }),
            },
          }),
          defineModel({
            name: 'test.invoice',
            retention: { reason: { fr: 'Conservation de test' } },
            fields: { partnerId: f.many2one('res.partner') },
          }),
        ],
      },
    ],
    { side },
  );
  const security = buildSecurityPolicy(
    [
      ...loaded.map((module) => module.security),
      {
        module: 'test',
        groups: [{ id: 'test.reader', name: { fr: 'Lecteur' } }],
        access: [{ model: 'res.partner', group: 'test.reader', read: true }],
      },
    ],
    (name) => registry.has(name),
  );
  const storage = createMemoryStorage(registry);
  const events: unknown[] = [];
  const environment = (user: UserContext): Environment =>
    createEnvironment({
      registry,
      storage,
      user,
      access: createAccessControl(security, registry),
      audit: {
        record: (event) => {
          events.push(event);
        },
      },
      now: () => '2026-10-02T12:00:00.000Z',
    });
  const seedUser: UserContext = {
    id: 'seed',
    groupIds: ['base.group_system'],
    companyIds: [],
    companyId: null,
    lang: 'fr',
    tz: 'Africa/Algiers',
  };
  const seed = environment(seedUser).sudo('Public mail test data');
  const currency = await seed
    .model('res.currency')
    .create({ code: 'DZD', name: 'Dinar', decimals: 2 });
  const companies = await seed.model('res.company').create([
    { name: 'A', currencyId: currency.id },
    { name: 'B', currencyId: currency.id },
  ]);
  const [a, b] = companies.ids;
  if (!a || !b) throw new Error('Missing company fixtures.');
  const records = await seed.model('res.partner').create([
    { name: 'Atlas', companyId: a },
    { name: 'Oran', companyId: b },
  ]);
  const type = await seed
    .model('mail.activity.type')
    .create({ name: 'Appel', code: 'call', color: 1 });
  const [first, second] = records.ids;
  if (!first || !second) throw new Error('Missing contact fixtures.');
  const target = { model: 'res.partner', id: first };
  const foreign = { model: 'res.partner', id: second };
  const user: UserContext = { ...seedUser, id: 'writer', companyIds: [a], companyId: a };
  return {
    registry,
    security,
    storage,
    environment,
    seed,
    target,
    foreign,
    typeId: type.id,
    user,
    writer: environment(user),
    reader: environment({ ...user, id: 'reader', groupIds: ['test.reader'] }),
    colleague: environment({ ...user, id: 'colleague' }),
    events,
    loaded,
  };
}

describe('mail conversations and personal activities', () => {
  it('composes with the real base module, preserves field definitions and declares a generic chatter', () => {
    const fixture = fixtureForComposition();
    const views = buildViewRegistry(
      fixture.loaded.map((module) => module.views),
      fixture.registry,
    );
    expect(
      views.get('base.partner_form').arch.children.at(-1)?.children[0]?.children[0]?.type,
    ).toBe('chatter');
    expect(fixture.registry.field('res.partner', 'name')).toMatchObject({
      required: true,
      tracking: true,
    });
    expect(fixture.registry.get('res.partner').serverMethodNames).not.toContain('afterAnonymize');
    expect(fixture.registry.get('mail.message').offline).toMatchObject({
      conflict: 'append-only',
      syncable: false,
    });
  });
  it('keeps messages as text, derives the author and rejects forged attributes and direct table access', async () => {
    const f = await fixture();
    const text = '<img src=x onerror=alert(1)>\nBonjour';
    const row = await postMessage(
      f.writer,
      f.target,
      { body: text, kind: 'comment' },
      { internal: true },
    );
    expect(row).toMatchObject({ body: text, authorId: 'writer' });
    await expect(
      postMessage(
        f.writer,
        f.target,
        { body: 'Spoof', kind: 'comment', authorId: 'colleague' },
        { internal: true },
      ),
    ).rejects.toThrow();
    for (const env of [f.writer, f.reader]) {
      await expect(env.model('mail.message').search()).rejects.toThrow(AccessError);
      await expect(env.model('mail.activity').search()).rejects.toThrow(AccessError);
    }
    const message = f.seed.model('mail.message').browse([String(row?.id)]);
    await expect(message.write({ body: 'Changed' })).rejects.toThrow(ValidationError);
    await expect(message.unlink()).rejects.toThrow(ValidationError);
  });
  it('rechecks parent company and write rights and filters internal notes for readers', async () => {
    const f = await fixture();
    await postMessage(f.writer, f.target, { body: 'Public', kind: 'comment' }, { internal: true });
    await postMessage(f.writer, f.target, { body: 'Interne', kind: 'note' }, { internal: true });
    expect(
      (await readThread(f.reader, f.target, { internal: false })).messages.map(
        (message) => message.body,
      ),
    ).toEqual(['Public']);
    expect(
      (await readThread(f.reader, f.target, { internal: true })).messages.map((row) => row.body),
    ).toEqual(['Public']);
    await expect(
      postMessage(f.reader, f.target, { body: 'Denied', kind: 'note' }, { internal: true }),
    ).rejects.toThrow(AccessError);
    await expect(
      postMessage(f.reader, f.target, { body: 'Denied', kind: 'comment' }, { internal: false }),
    ).rejects.toThrow(AccessError);
    await expect(readThread(f.writer, f.foreign, { internal: true })).rejects.toThrow(
      MissingRecordError,
    );
    await expect(
      postMessage(f.writer, f.foreign, { body: 'Denied', kind: 'comment' }, { internal: true }),
    ).rejects.toThrow(MissingRecordError);
  });
  it('tracks writes and direct assignments exactly once, excluding unchanged and private values', async () => {
    const f = await fixture();
    await f.writer
      .model('res.partner')
      .browse([f.target.id])
      .write({ name: 'Atlas 2', privateValue: 'restricted', secretValue: 'sensitive' });
    const record = f.writer.model('res.partner').browse([f.target.id]) as unknown as Recordset & {
      name: string;
    };
    record.name = 'Atlas 3';
    await f.writer.flush();
    await record.write({ name: 'Atlas 3' });
    const messages = (await readThread(f.writer, f.target, { internal: true })).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.changes).toEqual({ name: { before: 'Atlas', after: 'Atlas 2' } });
    expect(messages[1]?.changes).toEqual({ name: { before: 'Atlas 2', after: 'Atlas 3' } });
    expect(JSON.stringify(messages)).not.toContain('restricted');
    expect(JSON.stringify(messages)).not.toContain('sensitive');
  });
  it('filters historical tracking fields against current restrictions in reads and exports', async () => {
    const f = await fixture();
    await f.seed.model('mail.message').create({
      resModel: f.target.model,
      resId: f.target.id,
      authorId: f.user.id,
      companyId: f.user.companyId,
      kind: 'tracking',
      body: 'Historical tracking',
      changes: {
        name: { before: 'Old', after: 'New' },
        privateValue: { before: 'Private before', after: 'Private after' },
        secretValue: { before: 'Secret before', after: 'Secret after' },
      },
    });
    const page = await readThread(f.writer, f.target, { internal: true });
    expect(page.messages[0]?.changes).toEqual({ name: { before: 'Old', after: 'New' } });
    const exported = await f.writer.model('res.partner').browse([f.target.id]).gdprExport();
    expect(exported.related['mail.messages']?.[0]?.changes).toEqual({
      name: { before: 'Old', after: 'New' },
    });
  });

  it('paginates 51 messages without duplicates and without exposing an internal-note count', async () => {
    const f = await fixture();
    for (let index = 0; index < 51; index += 1)
      await postMessage(
        f.writer,
        f.target,
        { body: String(index), kind: 'comment' },
        { internal: true },
      );
    const latest = await readThread(f.reader, f.target, { internal: false });
    expect(latest.messages).toHaveLength(50);
    expect(latest.before).not.toBeNull();
    const previous = await readThread(
      f.reader,
      f.target,
      { internal: false },
      { before: latest.before },
    );
    expect(previous.messages).toHaveLength(1);
    expect(previous.before).toBeNull();
    expect(new Set([...previous.messages, ...latest.messages].map((row) => row.id)).size).toBe(51);
  });
  it('schedules only for the caller and completes once with an immutable feedback message', async () => {
    const f = await fixture();
    const value = { summary: 'Appeler Atlas', typeId: f.typeId, dueDate: '2026-10-03' };
    await expect(
      scheduleActivity(f.writer, f.target, { ...value, assignedUserId: 'colleague' }),
    ).rejects.toThrow();
    await expect(
      scheduleActivity(f.writer, f.target, { ...value, dueDate: '2026-02-30' }),
    ).rejects.toThrow();
    const activity = await scheduleActivity(f.writer, f.target, value);
    expect(activity?.assignedUserId).toBe('writer');
    await expect(
      finishActivity(f.colleague, f.target, String(activity?.id), {
        state: 'done',
        feedback: 'Spoof',
      }),
    ).rejects.toThrow(MissingRecordError);
    await finishActivity(f.writer, f.target, String(activity?.id), {
      state: 'done',
      feedback: 'Contacté',
    });
    expect((await readThread(f.writer, f.target, { internal: true })).activities).toHaveLength(0);
    expect((await readThread(f.writer, f.target, { internal: true })).messages.at(-1)?.body).toBe(
      'Appeler Atlas\nContacté',
    );
    await expect(
      finishActivity(f.writer, f.target, String(activity?.id), { state: 'done' }),
    ).rejects.toThrow(MissingRecordError);
  });
  it('notifies subscribers except the author and hides notifications and deadlines after access revocation', async () => {
    const f = await fixture();
    await followThread(f.colleague, f.target, { following: true });
    await followThread(f.colleague, f.target, { following: true });
    await postMessage(f.writer, f.target, { body: 'Nouveau', kind: 'comment' }, { internal: true });
    const notifications = await readNotifications(f.colleague, { internal: true });
    expect(notifications).toHaveLength(1);
    expect(await readNotifications(f.writer, { internal: true })).toHaveLength(0);
    await expect(markNotificationRead(f.writer, String(notifications[0]?.id))).rejects.toThrow(
      MissingRecordError,
    );
    await scheduleActivity(f.colleague, f.target, {
      summary: 'Rappel',
      typeId: f.typeId,
      dueDate: '2026-10-02',
    });
    expect(await readActivities(f.colleague)).toHaveLength(1);
    const revoked = f.environment({ ...f.user, id: 'colleague', companyIds: [], companyId: null });
    expect(await readNotifications(revoked, { internal: true })).toHaveLength(0);
    expect(await readActivities(revoked)).toHaveLength(0);
    await markNotificationRead(f.colleague, String(notifications[0]?.id));
    expect(await readNotifications(f.colleague, { internal: true })).toHaveLength(0);
  });
  it('exports authorized mail and erases identifying history when a contact is anonymized', async () => {
    const f = await fixture();
    await postMessage(
      f.writer,
      f.target,
      { body: 'Personal note', kind: 'note' },
      { internal: true },
    );
    await f.writer
      .model('res.partner')
      .browse([f.target.id])
      .write({ email: 'public@example.test' });
    await scheduleActivity(f.writer, f.target, {
      summary: 'Personal reminder',
      typeId: f.typeId,
      dueDate: '2026-10-03',
    });
    const partner = f.writer.model('res.partner').browse([f.target.id]);
    expect((await partner.gdprExport()).related['mail.messages']).toHaveLength(2);
    await partner.gdprAnonymize();
    const page = await readThread(f.writer, f.target, { internal: true });
    expect(
      page.messages.every((message) => message.body === 'Anonymisé' && message.changes === null),
    ).toBe(true);
    expect(page.activities).toHaveLength(0);
    expect(JSON.stringify(await partner.gdprExport())).not.toContain('public@example.test');
  });
  it('keeps history when the base legal-retention check refuses anonymization', async () => {
    const f = await fixture();
    await postMessage(f.writer, f.target, { body: 'Kept', kind: 'comment' }, { internal: true });
    await f.seed.model('test.invoice').create({ partnerId: f.target.id });
    await expect(
      f.writer.model('res.partner').browse([f.target.id]).gdprAnonymize(),
    ).rejects.toThrow(/obligation/);
    expect((await readThread(f.writer, f.target, { internal: true })).messages[0]?.body).toBe(
      'Kept',
    );
  });
  it('compares calendar dates without applying a server time zone', () => {
    expect(activityStatus('2026-10-01', '2026-10-02')).toBe('overdue');
    expect(activityStatus('2026-10-02', '2026-10-02')).toBe('today');
    expect(activityStatus('2026-10-03', '2026-10-02')).toBe('planned');
    expect(() => activityStatus('2026-02-30', '2026-10-02')).toThrow();
  });
});

function fixtureForComposition() {
  const loaded = ['base', 'mail'].map((name) => modules.get(name));
  for (const side of ['server', 'client'] as const) {
    const registry = buildModelRegistry(
      loaded.map((module) => module.models),
      { side },
    );
    buildViewRegistry(
      loaded.map((module) => module.views),
      registry,
    );
  }
  return {
    loaded,
    registry: buildModelRegistry(
      loaded.map((module) => module.models),
      { side: 'server' },
    ),
  };
}
