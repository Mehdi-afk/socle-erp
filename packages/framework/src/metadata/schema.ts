// SPDX-License-Identifier: LGPL-3.0-only
import { z } from 'zod';

import type { ViewNode } from '../views/nodes.js';
import type { FieldSnapshot, ModelSnapshot, RegistrySnapshot } from './types.js';

const modelName = z
  .string()
  .min(1)
  .max(63)
  .refine((value) => value.split('.').every((part) => /^[a-z][a-z0-9_]*$/.test(part)));
const fieldName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][A-Za-z0-9]*$/);
const text = z.string().max(4096);
const name = z.string().min(1).max(128);
const localized = z.strictObject({ fr: text, en: text.optional(), ar: text.optional() });
export const widgets = [
  'avatar',
  'status_badge',
  'phone',
  'email',
  'url',
  'editable-list',
] as const;
export const tones = ['neutral', 'info', 'success', 'warning', 'danger'] as const;
const toneMap = z.record(z.string().min(1).max(254), z.enum(tones));

/** Attribute allow-lists are shared by wire validation and the server projection. */
export const nodeAttributes = {
  form: z.strictObject({}),
  list: z.strictObject({}),
  header: z.strictObject({
    title: fieldName.optional(),
    subtitle: fieldName.optional(),
    avatar: fieldName.optional(),
  }),
  sheet: z.strictObject({}),
  group: z.strictObject({ name: name.optional(), label: localized.optional() }),
  notebook: z.strictObject({}),
  page: z.strictObject({ name: name.optional(), label: localized.optional() }),
  field: z.strictObject({
    name: fieldName,
    label: localized.optional(),
    widget: z.enum(widgets).optional(),
    readonly: z.boolean().optional(),
    tones: toneMap.optional(),
  }),
  button: z.strictObject({ name, label: localized.optional(), primary: z.boolean().optional() }),
};
export type SnapshotNodeType = keyof typeof nodeAttributes;
export const nodeTypes = Object.keys(nodeAttributes) as SnapshotNodeType[];

const fieldSchema = z
  .strictObject({
    name: fieldName,
    type: z.enum([
      'char',
      'text',
      'html',
      'integer',
      'decimal',
      'monetary',
      'boolean',
      'date',
      'datetime',
      'selection',
      'many2one',
      'one2many',
      'many2many',
      'binary',
      'json',
      'reference',
    ]),
    stored: z.boolean(),
    readonly: z.boolean(),
    label: localized.optional(),
    help: localized.optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    size: z.number().int().min(1).max(1_000_000).optional(),
    selection: z
      .array(z.tuple([z.string().min(1).max(254), text]))
      .min(1)
      .max(1000)
      .optional(),
    comodel: modelName.optional(),
    inverse: fieldName.optional(),
    digits: z
      .tuple([z.number().int().min(1).max(1000), z.number().int().min(0).max(100)])
      .optional(),
    currencyField: fieldName.optional(),
  })
  .superRefine((field, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const relational = ['many2one', 'one2many', 'many2many'].includes(field.type);
    if (relational !== (field.comodel !== undefined))
      fail('Relations require a target model; other fields cannot have one.');
    if ((field.type === 'one2many') !== (field.inverse !== undefined))
      fail('Only one2many fields require an inverse.');
    if ((field.type === 'selection') !== (field.selection !== undefined))
      fail('Only selection fields require choices.');
    if (
      field.selection &&
      new Set(field.selection.map(([key]) => key)).size !== field.selection.length
    )
      fail('Duplicate selection key.');
    if (field.digits && (field.type !== 'decimal' || field.digits[1] > field.digits[0]))
      fail('Invalid decimal precision.');
    if (field.size !== undefined && field.type !== 'char')
      fail('Only char fields have a maximum length.');
    if (field.currencyField !== undefined && field.type !== 'monetary')
      fail('Only monetary fields have a currency field.');
    if ((field.type === 'one2many' || field.type === 'many2many') && field.stored)
      fail('Collection relations are not stored columns.');
    if (!field.stored && !field.readonly) fail('Non-stored fields must be read-only.');
  });

const nodeSchema: z.ZodType<ViewNode> = z.lazy(() =>
  z
    .strictObject({
      type: z.enum([
        'form',
        'list',
        'header',
        'sheet',
        'group',
        'notebook',
        'page',
        'field',
        'button',
      ]),
      attrs: z.record(z.string().max(64), z.union([text, z.boolean(), localized, toneMap])),
      children: z.array(nodeSchema).max(200),
    })
    .superRefine((node, ctx) => {
      if (!nodeAttributes[node.type].safeParse(node.attrs).success) {
        ctx.addIssue({ code: 'custom', path: ['attrs'], message: 'Unsupported view attributes.' });
      }
      if (node.type === 'button' && node.children.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['children'],
          message: 'Buttons cannot have children.',
        });
      }
    }),
);

const permissionsSchema = z.strictObject({
  create: z.boolean(),
  write: z.boolean(),
  unlink: z.boolean(),
});
const orderSchema = z.strictObject({ field: fieldName, direction: z.enum(['asc', 'desc']) });
const modelSchema = z.strictObject({
  name: modelName,
  description: localized.optional(),
  permissions: permissionsSchema,
  fields: z.array(fieldSchema).min(1).max(1000),
  order: z.array(orderSchema).min(1).max(100),
});
const viewSchema = z.strictObject({
  id: z
    .string()
    .min(3)
    .max(128)
    .refine(
      (value) =>
        value.includes('.') && value.split('.').every((part) => /^[a-z][a-z0-9_]*$/.test(part)),
    ),
  model: modelName,
  type: z.enum(['form', 'list']),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  arch: nodeSchema,
});

/** The dependencies the current renderer needs for one field. */
export function referencesClosed(
  field: FieldSnapshot,
  model: ModelSnapshot,
  models: ReadonlyMap<string, ModelSnapshot>,
): boolean {
  if (field.comodel !== undefined) {
    const target = models.get(field.comodel);
    if (!target) return false;
    if (field.type === 'one2many') {
      const inverse = target.fields.find((candidate) => candidate.name === field.inverse);
      if (
        inverse?.type !== 'many2one' ||
        inverse.comodel !== model.name ||
        !inverse.stored ||
        inverse.sensitive
      )
        return false;
    }
    // The current lookup cache fetches currency details even for a plain currency relation.
    if (field.comodel === 'res.currency') {
      const code = target.fields.find((candidate) => candidate.name === 'code');
      const decimals = target.fields.find((candidate) => candidate.name === 'decimals');
      if (
        code?.type !== 'char' ||
        code.sensitive ||
        decimals?.type !== 'integer' ||
        decimals.sensitive
      )
        return false;
    }
  }
  if (field.type === 'monetary') {
    const currency = model.fields.find(
      (candidate) => candidate.name === (field.currencyField ?? 'currencyId'),
    );
    const target = models.get('res.currency');
    const code = target?.fields.find((candidate) => candidate.name === 'code');
    const decimals = target?.fields.find((candidate) => candidate.name === 'decimals');
    if (
      currency?.type !== 'many2one' ||
      currency.comodel !== 'res.currency' ||
      currency.sensitive ||
      code?.type !== 'char' ||
      code.sensitive ||
      decimals?.type !== 'integer' ||
      decimals.sensitive
    )
      return false;
  }
  return true;
}

export const registrySnapshotSchema: z.ZodType<RegistrySnapshot> = z
  .strictObject({
    version: z.literal(1),
    userId: z.string().min(1).max(254),
    companyId: z.string().min(1).max(254).nullable(),
    models: z.array(modelSchema).max(500),
    views: z.array(viewSchema).max(2000),
  })
  .superRefine((snapshot, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const models = new Map(snapshot.models.map((model) => [model.name, model]));
    if (models.size !== snapshot.models.length) fail('Duplicate model.');
    if (new Set(snapshot.views.map((view) => view.id)).size !== snapshot.views.length)
      fail('Duplicate view.');
    for (const model of snapshot.models) {
      const fields = new Map(model.fields.map((field) => [field.name, field]));
      if (fields.size !== model.fields.length) fail('Duplicate field.');
      const id = fields.get('id');
      if (id?.type !== 'char' || !id.readonly || !id.stored || !id.required)
        fail('A model requires a stored read-only id.');
      for (const field of model.fields) {
        if (!referencesClosed(field, model, models)) fail('Unresolved field dependency.');
        if (!model.permissions.write && !field.readonly)
          fail('Fields without write capability must be read-only.');
      }
      if (new Set(model.order.map((term) => term.field)).size !== model.order.length)
        fail('Duplicate order field.');
      if (model.order.some((term) => !fields.get(term.field)?.stored))
        fail('Order references an absent or non-stored field.');
    }
    const walk = (node: ViewNode, model: ModelSnapshot): void => {
      let childModel = model;
      if (node.type === 'field') {
        const field = model.fields.find((candidate) => candidate.name === node.attrs.name);
        if (!field) {
          fail('View references an absent field.');
          return;
        }
        if (node.children.length > 0) {
          if (
            field.type !== 'one2many' ||
            !field.comodel ||
            node.children.some((child) => child.type !== 'list')
          ) {
            fail('Only one2many fields can contain embedded lists.');
            return;
          }
          const target = models.get(field.comodel);
          if (!target) {
            fail('View references an absent target.');
            return;
          }
          childModel = target;
        }
      }
      if (node.type === 'header') {
        for (const attribute of ['title', 'subtitle', 'avatar']) {
          const name = node.attrs[attribute];
          if (name === undefined) continue;
          const field = model.fields.find((candidate) => candidate.name === name);
          if (!field || field.sensitive) fail('Header references an absent or sensitive field.');
        }
      }
      for (const child of node.children) walk(child, childModel);
    };
    for (const view of snapshot.views) {
      const model = models.get(view.model);
      if (!model) {
        fail('View references an absent model.');
        continue;
      }
      if (view.arch.type !== view.type) fail('View root and type differ.');
      walk(view.arch, model);
    }
  });

/** Bound traversal before recursive Zod parsing, including cyclic or non-JSON callers. */
export function checkSnapshotSize(value: unknown): void {
  const pending: { value: unknown; depth: number; leaving?: boolean }[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  let textSize = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const item = current.value;
    if (current.leaving && item !== null && typeof item === 'object') {
      ancestors.delete(item);
      continue;
    }
    if (++nodes > 100_000 || current.depth > 48)
      throw new Error('Registry snapshot exceeds its structural limits.');
    if (typeof item === 'string') {
      textSize += item.length;
      if (item.length > 4096 || textSize > 4_000_000)
        throw new Error('Registry snapshot exceeds its text limits.');
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Registry snapshot contains a non-JSON number.');
    } else if (item !== null && typeof item === 'object') {
      if (ancestors.has(item)) throw new Error('Registry snapshot contains a cycle.');
      ancestors.add(item);
      pending.push({ value: item, depth: current.depth, leaving: true });
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new Error('Registry snapshot contains a non-JSON object.');
      if (Array.isArray(item) && item.length > 100_000)
        throw new Error('Registry snapshot exceeds its array limits.');
      if (Reflect.ownKeys(item).some((key) => typeof key === 'symbol'))
        throw new Error('Registry snapshot contains a symbol property.');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(item) && key === 'length') continue;
        if (
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          key.length > 254 ||
          !Object.hasOwn(descriptor, 'value') ||
          !descriptor.enumerable
        )
          throw new Error('Registry snapshot contains an unsupported property.');
        pending.push({ value: descriptor.value as unknown, depth: current.depth + 1 });
      }
    } else if (item !== null && typeof item !== 'boolean') {
      throw new Error('Registry snapshot contains a non-JSON value.');
    }
  }
}
