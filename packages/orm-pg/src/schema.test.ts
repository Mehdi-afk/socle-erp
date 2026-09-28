// SPDX-License-Identifier: LGPL-3.0-only
import {
  buildModelRegistry,
  defineModel,
  extendModel,
  f,
  type ModelDefinition,
  type ModelExtension,
} from '@socle/framework';
import { describe, expect, it } from 'vitest';

import { SchemaError } from './errors.js';
import { columnName, identifier } from './naming.js';
import { buildSchema, diffSchema, type DatabaseSchema, type TableSchema } from './schema.js';

const partnerFields = {
  name: f.char({ index: true }),
  email: f.char(),
  rank: f.integer(),
  active: f.boolean(),
  parentId: f.many2one('sch.partner', { ondelete: 'cascade' }),
  tagIds: f.many2many('sch.tag'),
  childIds: f.one2many('sch.partner', 'parentId'),
  label: f.char({ compute: 'computeLabel' }),
};
const partner = defineModel({
  name: 'sch.partner',
  fields: partnerFields,
  unique: [{ name: 'email_uniq', fields: ['email'] }],
  methods: (Base) =>
    class extends Base {
      computeLabel(): void {
        for (const record of this) record.label = record.name;
      }
    },
});
const tag = defineModel({ name: 'sch.tag', fields: { name: f.char() } });
const mixin = defineModel({ name: 'sch.mixin', abstract: true, fields: { note: f.text() } });

const schemaOf = (...models: (ModelDefinition | ModelExtension)[]): DatabaseSchema =>
  buildSchema(buildModelRegistry([{ module: 'sch', models }], { side: 'server' }));

const table = (schema: DatabaseSchema, name: string): TableSchema => {
  const found = schema.tables.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no table ${name}`);
  return found;
};

describe('naming', () => {
  it('maps camelCase fields to snake_case columns', () => {
    expect(columnName('partnerId')).toBe('partner_id');
    expect(columnName('createdAt')).toBe('created_at');
    expect(columnName('vatNumber2')).toBe('vat_number2');
  });

  it('refuses identifiers outside the allow-list or longer than 63 characters', () => {
    expect(() => identifier('a"; drop table x')).toThrow(SchemaError);
    expect(() => identifier('Name')).toThrow(SchemaError);
    expect(() => identifier('a'.repeat(64))).toThrow(SchemaError);
    expect(identifier('a'.repeat(63))).toHaveLength(63);
  });
});

describe('buildSchema', () => {
  const schema = schemaOf(partner, tag, mixin);

  it('creates one table per concrete model and one per many2many', () => {
    expect(schema.tables.map((t) => t.name)).toEqual([
      'sch_partner',
      'sch_partner_tag_ids_rel',
      'sch_tag',
    ]);
  });

  it('maps field types, technical columns and empty values', () => {
    const columns = new Map(table(schema, 'sch_partner').columns.map((c) => [c.name, c]));
    expect(columns.get('id')).toEqual({ name: 'id', type: 'uuid', notNull: true });
    expect(columns.get('rank')).toEqual({
      name: 'rank',
      type: 'bigint',
      notNull: true,
      default: 0,
    });
    expect(columns.get('active')).toEqual({
      name: 'active',
      type: 'boolean',
      notNull: true,
      default: false,
    });
    expect(columns.get('parent_id')?.type).toBe('uuid');
    expect(columns.get('created_at')?.type).toBe('timestamptz');
    expect(columns.get('version')?.type).toBe('bigint');
    // Non-stored computed fields and one2many have no column.
    expect(columns.has('label')).toBe(false);
    expect(columns.has('child_ids')).toBe(false);
  });

  it('declares foreign keys, indexes and unique constraints', () => {
    const partners = table(schema, 'sch_partner');
    expect(partners.foreignKeys).toEqual([
      {
        name: 'sch_partner_parent_id_fk',
        column: 'parent_id',
        references: 'sch_partner',
        onDelete: 'cascade',
      },
    ]);
    expect(partners.indexes.map((i) => i.name).sort()).toEqual([
      'sch_partner_name_idx',
      'sch_partner_parent_id_idx',
      // Changes since a synchronisation cursor are read by version.
      'sch_partner_version_idx',
    ]);
    expect(partners.uniques).toEqual([{ name: 'sch_partner_email_uniq_key', columns: ['email'] }]);
    const rel = table(schema, 'sch_partner_tag_ids_rel');
    expect(rel.primaryKey).toEqual(['source_id', 'target_id']);
    expect(rel.foreignKeys.map((fk) => [fk.references, fk.onDelete])).toEqual([
      ['sch_partner', 'cascade'],
      ['sch_tag', 'cascade'],
    ]);
  });

  it('maps ondelete restrict to a deferrable NO ACTION', () => {
    const order = defineModel({
      name: 'sch.order',
      fields: { partnerId: f.many2one('sch.partner', { ondelete: 'restrict' }) },
    });
    const orders = table(schemaOf(partner, tag, order), 'sch_order');
    expect(orders.foreignKeys[0]?.onDelete).toBe('no action');
  });

  it('refuses two models that would share a table', () => {
    const a = defineModel({ name: 'sch.a_b', fields: {} });
    const b = defineModel({ name: 'sch_a.b', fields: {} });
    expect(() => schemaOf(a, b)).toThrow(/both need the SQL name "sch_a_b"/);
  });

  it('reserves the table of the recorded schema', () => {
    const clash = defineModel({ name: 'socle.schema', fields: {} });
    expect(() => schemaOf(clash)).toThrow(SchemaError);
  });
});

describe('diffSchema', () => {
  const v1 = schemaOf(partner, tag);

  it('creates everything on an empty database, constraints last', () => {
    const plan = diffSchema(null, v1);
    const kinds = plan.operations.map((op) => op.kind);
    expect(kinds.filter((k) => k === 'createTable')).toHaveLength(3);
    expect(kinds.lastIndexOf('createTable')).toBeLessThan(kinds.indexOf('addForeignKey'));
    expect(plan.destructive).toEqual([]);
    expect(plan.recorded).toEqual(v1);
  });

  it('plans nothing when the schema did not change', () => {
    expect(diffSchema(v1, v1).operations).toEqual([]);
  });

  it('adds new fields and models automatically', () => {
    const extension = extendModel('sch.partner', {
      fields: { phone: f.char({ index: true }), score: f.integer() },
    });
    const v2 = schemaOf(partner, tag, extension);
    const plan = diffSchema(v1, v2);
    expect(plan.operations).toEqual([
      {
        kind: 'addColumn',
        table: 'sch_partner',
        column: { name: 'phone', type: 'text', notNull: false },
      },
      {
        kind: 'addColumn',
        table: 'sch_partner',
        column: { name: 'score', type: 'bigint', notNull: true, default: 0 },
      },
      {
        kind: 'createIndex',
        table: 'sch_partner',
        index: { name: 'sch_partner_phone_idx', columns: ['phone'] },
      },
    ]);
    expect(plan.destructive).toEqual([]);
  });

  it('never changes a column type automatically', () => {
    const changed = defineModel({ ...partner, fields: { ...partnerFields, rank: f.char() } });
    const plan = diffSchema(v1, schemaOf(changed, tag));
    expect(plan.destructive).toEqual(['sch_partner.rank: type bigint → text']);
  });

  it('keeps removed columns and tables with their data, and drops their constraints', () => {
    const fields = Object.fromEntries(
      Object.entries(partnerFields).filter(
        ([name]) => !['tagIds', 'parentId', 'childIds'].includes(name),
      ),
    );
    const slim = defineModel({ ...partner, fields });
    const plan = diffSchema(v1, schemaOf(slim, tag));
    expect(plan.orphans).toEqual(['sch_partner.parent_id', 'sch_partner_tag_ids_rel']);
    expect(plan.operations.map((op) => op.kind).sort()).toEqual([
      'dropForeignKey',
      'dropForeignKey',
      'dropForeignKey',
      'dropIndex',
      'dropIndex',
    ]);
    const recorded = table(plan.recorded, 'sch_partner').columns.find(
      (c) => c.name === 'parent_id',
    );
    expect(recorded?.orphan).toBe(true);
    // Re-adding the field with the same type adopts the kept column: nothing to create.
    const again = diffSchema(plan.recorded, v1);
    expect(
      again.operations.some((op) => op.kind === 'addColumn' || op.kind === 'createTable'),
    ).toBe(false);
    expect(again.destructive).toEqual([]);
  });

  it('rebuilds a foreign key whose ondelete changed', () => {
    const changed = defineModel({
      ...partner,
      fields: { ...partnerFields, parentId: f.many2one('sch.partner', { ondelete: 'set null' }) },
    });
    const plan = diffSchema(v1, schemaOf(changed, tag));
    expect(plan.operations.map((op) => op.kind)).toEqual(['dropForeignKey', 'addForeignKey']);
  });
});
