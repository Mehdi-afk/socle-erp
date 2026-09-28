// SPDX-License-Identifier: LGPL-3.0-only
//
// Access rights and record rules as records, mirrored from the modules' security/ files for
// the administration screens (read only: the code stays the source of truth).
import { defineModel, f } from '@socle/framework';

export const access = defineModel({
  name: 'ir.model.access',
  description: { fr: "Droit d'accès", en: 'Access right', ar: 'حق الوصول' },
  order: 'modelName',
  offline: { syncable: false },
  fields: {
    modelName: f.char({ required: true, readonly: true }),
    groupId: f.many2one('res.groups', { readonly: true, ondelete: 'cascade' }),
    permRead: f.boolean({ readonly: true }),
    permCreate: f.boolean({ readonly: true }),
    permWrite: f.boolean({ readonly: true }),
    permUnlink: f.boolean({ readonly: true }),
  },
});

export const rule = defineModel({
  name: 'ir.rule',
  description: { fr: "Règle d'enregistrement", en: 'Record rule', ar: 'قاعدة السجلات' },
  order: 'code',
  offline: { syncable: false },
  unique: [{ name: 'code_uniq', fields: ['code'] }],
  fields: {
    code: f.char({ required: true, readonly: true }),
    modelName: f.char({ required: true, readonly: true }),
    domain: f.json({ readonly: true }),
    operations: f.json({ readonly: true }),
    groupIds: f.many2many('res.groups', { relation: 'ir_rule_group_rel', readonly: true }),
  },
});

export default [access, rule];
