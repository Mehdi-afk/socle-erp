// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createEnvironment, type AuditEvent } from './environment.js';
import { f } from './fields.js';
import { createMemoryStorage } from './memory-storage.js';
import { defineModel } from './model.js';
import { buildModelRegistry } from './model-registry.js';

const patient = defineModel({
  name: 'au.patient',
  fields: { name: f.char(), diagnosis: f.text({ sensitive: true }) },
});
const registry = buildModelRegistry([{ module: 'au', models: [patient] }], { side: 'server' });

describe('audit events of the ORM', () => {
  it('records changes with field names and sensitive reads, never values', async () => {
    const events: AuditEvent[] = [];
    const env = createEnvironment({
      registry,
      storage: createMemoryStorage(registry),
      user: { id: 'doc', groupIds: [], companyIds: [], companyId: null, lang: 'fr', tz: 'UTC' },
      access: { checkModel: () => undefined, ruleDomain: () => ({ kind: 'true' }) },
      audit: { record: (event) => events.push(event) },
      now: () => '2026-09-28T10:00:00.000Z',
    });
    const record = await env.model('au.patient').create({ name: 'A', diagnosis: 'secret' });
    await record.write({ name: 'B' });
    await record.read(['name']);
    await record.read(['name', 'diagnosis']);
    await record.sudo('export for the patient').unlink();

    const types = events.map((event) => event.type);
    expect(types).toEqual(['create', 'write', 'read_sensitive', 'sudo', 'unlink']);
    expect(events[0]).toMatchObject({
      model: 'au.patient',
      ids: record.ids,
      fields: ['diagnosis', 'name'],
      su: false,
    });
    expect(events[2]).toMatchObject({ fields: ['diagnosis'], userId: 'doc' });
    expect(events[4]).toMatchObject({ su: true });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});
