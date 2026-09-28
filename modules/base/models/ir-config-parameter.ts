// SPDX-License-Identifier: LGPL-3.0-only
//
// Settings as key/value pairs, per company (empty company: default for all). Never a place
// for secrets (passwords, API keys): those go in the server's environment.
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'ir.config_parameter',
  description: { fr: 'Paramètre', en: 'Parameter', ar: 'إعداد' },
  mixins: ['company.scoped'],
  order: 'key',
  offline: { syncable: false },
  unique: [{ name: 'key_uniq', fields: ['key', 'companyId'] }],
  fields: {
    key: f.char({ required: true, label: { fr: 'Clé', en: 'Key', ar: 'المفتاح' } }),
    value: f.text({ label: { fr: 'Valeur', en: 'Value', ar: 'القيمة' } }),
  },
});
