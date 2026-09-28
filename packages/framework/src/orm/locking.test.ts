// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createEnvironment, type UserContext } from './environment.js';
import { RecordsetError, ServerOnlyError } from './errors.js';
import { f } from './fields.js';
import { createMemoryStorage } from './memory-storage.js';
import { defineModel } from './model.js';
import { buildModelRegistry } from './model-registry.js';

const item = defineModel({ name: 'lk.item', fields: { name: f.char() } });
const user: UserContext = {
  id: 'u1',
  groupIds: [],
  companyIds: [],
  companyId: null,
  lang: 'fr',
  tz: 'UTC',
};

function env(side: 'server' | 'client') {
  const registry = buildModelRegistry([{ module: 'lk', models: [item] }], { side });
  return createEnvironment({
    registry,
    storage: createMemoryStorage(registry),
    user,
    access: { checkModel: () => undefined, ruleDomain: () => ({ kind: 'true' }) },
    audit: { record: () => undefined },
  });
}

describe('locks and counters', () => {
  it('count from start by step and validate their arguments', async () => {
    const server = env('server');
    expect(await server.nextValue('doc.number', { start: 100, step: 10 })).toBe(100);
    expect(await server.nextValue('doc.number', { start: 100, step: 10 })).toBe(110);
    expect(await server.nextValue('other')).toBe(1);
    await expect(server.nextValue('Bad Name')).rejects.toThrow(RecordsetError);
    await expect(server.nextValue('x', { step: 0 })).rejects.toThrow(RecordsetError);
  });

  it('lock records on the server and refuse both on the client', async () => {
    const server = env('server');
    const records = await server.model('lk.item').create({ name: 'A' });
    await expect(records.lockForUpdate()).resolves.toBeUndefined();

    const client = env('client');
    const local = await client.model('lk.item').create({ name: 'B' });
    await expect(local.lockForUpdate()).rejects.toThrow(ServerOnlyError);
    await expect(client.nextValue('doc.number')).rejects.toThrow(ServerOnlyError);
  });
});
