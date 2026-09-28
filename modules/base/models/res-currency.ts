// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f } from '@socle/framework';

export const currency = defineModel({
  name: 'res.currency',
  description: { fr: 'Devise', en: 'Currency', ar: 'عملة' },
  order: 'code',
  unique: [{ name: 'code_uniq', fields: ['code'] }],
  fields: {
    code: f.char({
      required: true,
      size: 3,
      label: { fr: 'Code ISO', en: 'ISO code', ar: 'رمز ISO' },
    }),
    name: f.char({ label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    numericCode: f.char({ size: 3 }),
    symbol: f.char({ size: 8 }),
    // ISO 4217 minor unit: amounts of this currency are integers of 10^-decimals.
    decimals: f.integer({
      required: true,
      default: 2,
      label: { fr: 'Décimales', en: 'Decimals', ar: 'الأرقام العشرية' },
    }),
    active: f.boolean({ default: true }),
    rateIds: f.one2many('res.currency.rate', 'currencyId'),
  },
});

export const rate = defineModel({
  name: 'res.currency.rate',
  description: { fr: 'Taux de change', en: 'Exchange rate', ar: 'سعر الصرف' },
  mixins: ['company.scoped'],
  order: 'date desc',
  unique: [{ name: 'day_uniq', fields: ['currencyId', 'date', 'companyId'] }],
  fields: {
    currencyId: f.many2one('res.currency', { required: true, ondelete: 'cascade' }),
    date: f.date({ required: true, label: { fr: 'Date', en: 'Date', ar: 'التاريخ' } }),
    // Units of this currency for one unit of the company currency (decimal string, decimal.js).
    rate: f.decimal({
      required: true,
      digits: [24, 12],
      label: { fr: 'Taux', en: 'Rate', ar: 'السعر' },
    }),
  },
});

export default [currency, rate];
