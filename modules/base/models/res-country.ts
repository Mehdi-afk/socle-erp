// SPDX-License-Identifier: LGPL-3.0-only
//
// Geographic reference data. Names are stored in French (official source); the client shows
// countries in the user language from their ISO code (Intl.DisplayNames).
import { defineModel, f } from '@socle/framework';

export const country = defineModel({
  name: 'res.country',
  description: { fr: 'Pays', en: 'Country', ar: 'بلد' },
  order: 'name',
  unique: [{ name: 'code_uniq', fields: ['code'] }],
  fields: {
    code: f.char({
      required: true,
      size: 2,
      label: { fr: 'Code ISO', en: 'ISO code', ar: 'رمز ISO' },
    }),
    name: f.char({ required: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    stateIds: f.one2many('res.country.state', 'countryId'),
  },
});

export const state = defineModel({
  name: 'res.country.state',
  description: { fr: 'Région / wilaya', en: 'State', ar: 'ولاية' },
  order: 'code',
  unique: [{ name: 'code_uniq', fields: ['countryId', 'code'] }],
  fields: {
    countryId: f.many2one('res.country', { required: true, ondelete: 'cascade' }),
    code: f.char({ required: true, size: 8 }),
    name: f.char({ required: true }),
  },
});

export const city = defineModel({
  name: 'res.city',
  description: { fr: 'Commune', en: 'City', ar: 'بلدية' },
  order: 'name',
  fields: {
    countryId: f.many2one('res.country', { required: true, ondelete: 'cascade' }),
    stateId: f.many2one('res.country.state', { ondelete: 'cascade' }),
    code: f.char({
      size: 16,
      label: { fr: 'Code officiel', en: 'Official code', ar: 'الرمز الرسمي' },
    }),
    name: f.char({ required: true }),
    zip: f.char({ size: 16 }),
  },
});

export default [country, state, city];
