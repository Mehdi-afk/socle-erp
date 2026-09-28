// SPDX-License-Identifier: LGPL-3.0-only
//
// Groups as records, mirrored from the security declarations of the installed modules (the
// code stays the source: security/groups.ts of each module), to be shown and assigned.
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'res.groups',
  description: { fr: "Groupe d'utilisateurs", en: 'User group', ar: 'مجموعة المستخدمين' },
  order: 'code',
  offline: { syncable: false },
  unique: [{ name: 'code_uniq', fields: ['code'] }],
  fields: {
    code: f.char({
      required: true,
      readonly: true,
      label: { fr: 'Code', en: 'Code', ar: 'الرمز' },
    }),
    // Localized name { fr, en, ar } as declared by the module.
    name: f.json({ readonly: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    impliedIds: f.many2many('res.groups', {
      relation: 'res_groups_implied_rel',
      readonly: true,
      label: { fr: 'Inclut', en: 'Implies', ar: 'يتضمن' },
    }),
  },
});
