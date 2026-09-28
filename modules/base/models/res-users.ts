// SPDX-License-Identifier: LGPL-3.0-only
//
// A user "has a" contact (delegation, Odoo's _inherits): name, email, address… live on the
// res.partner record. Credentials (password hash, MFA secrets) are never fields of a model:
// they stay in the server's authentication tables and are never synchronised.
import { defineModel, f, type Environment } from '@socle/framework';

export default defineModel({
  name: 'res.users',
  description: { fr: 'Utilisateur', en: 'User', ar: 'مستخدم' },
  inherits: { 'res.partner': 'partnerId' },
  order: 'login',
  offline: { syncable: false },
  unique: [{ name: 'login_uniq', fields: ['login'] }],
  fields: {
    login: f.char({
      required: true,
      index: true,
      label: { fr: 'Identifiant', en: 'Login', ar: 'اسم الدخول' },
    }),
    companyIds: f.many2many('res.company', {
      relation: 'res_company_users_rel',
      label: { fr: 'Sociétés autorisées', en: 'Allowed companies', ar: 'الشركات المسموح بها' },
    }),
    companyId: f.many2one('res.company', {
      required: true,
      default: (env: Environment) => env.companyId,
      label: { fr: 'Société courante', en: 'Current company', ar: 'الشركة الحالية' },
    }),
    groupIds: f.many2many('res.groups', {
      relation: 'res_groups_users_rel',
      label: { fr: 'Groupes', en: 'Groups', ar: 'المجموعات' },
    }),
    lang: f.selection(
      [
        ['fr', 'Français'],
        ['en', 'English'],
        ['ar', 'العربية'],
      ],
      { default: 'fr', label: { fr: 'Langue', en: 'Language', ar: 'اللغة' } },
    ),
    tz: f.char({
      default: 'Europe/Paris',
      label: { fr: 'Fuseau horaire', en: 'Time zone', ar: 'المنطقة الزمنية' },
    }),
    active: f.boolean({ default: true }),
  },
});
