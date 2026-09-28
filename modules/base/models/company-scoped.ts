// SPDX-License-Identifier: LGPL-3.0-only
//
// Mixin of every record that belongs to a company. The record rule "authorised company"
// (security/rules.ts) is declared once on this mixin and applies to every model using it.
import { defineModel, f, type Environment } from '@socle/framework';

export default defineModel({
  name: 'company.scoped',
  abstract: true,
  fields: {
    companyId: f.many2one('res.company', {
      label: { fr: 'Société', en: 'Company', ar: 'الشركة' },
      index: true,
      // The current company of the user; empty means shared by every company.
      default: (env: Environment) => env.companyId,
    }),
  },
});
