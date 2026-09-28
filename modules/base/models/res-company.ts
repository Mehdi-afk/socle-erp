// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'res.company',
  description: { fr: 'Société', en: 'Company', ar: 'شركة' },
  order: 'sequence, name',
  fields: {
    name: f.char({ required: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    sequence: f.integer({ default: 10 }),
    parentId: f.many2one('res.company', {
      ondelete: 'restrict',
      label: { fr: 'Société mère', en: 'Parent company', ar: 'الشركة الأم' },
    }),
    childIds: f.one2many('res.company', 'parentId', {
      label: { fr: 'Filiales', en: 'Subsidiaries', ar: 'الفروع' },
    }),
    currencyId: f.many2one('res.currency', {
      required: true,
      ondelete: 'restrict',
      label: { fr: 'Devise', en: 'Currency', ar: 'العملة' },
    }),
    countryId: f.many2one('res.country', { label: { fr: 'Pays', en: 'Country', ar: 'البلد' } }),
    stateId: f.many2one('res.country.state', {
      label: { fr: 'Région / wilaya', en: 'State', ar: 'الولاية' },
    }),
    tz: f.char({
      default: 'Europe/Paris',
      label: { fr: 'Fuseau horaire', en: 'Time zone', ar: 'المنطقة الزمنية' },
    }),
    logo: f.binary({ label: { fr: 'Logo', en: 'Logo', ar: 'الشعار' } }),
    email: f.char({ label: { fr: 'E-mail', en: 'Email', ar: 'البريد الإلكتروني' } }),
    phone: f.char({ label: { fr: 'Téléphone', en: 'Phone', ar: 'الهاتف' } }),
    street: f.char({ label: { fr: 'Rue', en: 'Street', ar: 'الشارع' } }),
    zip: f.char({ label: { fr: 'Code postal', en: 'ZIP', ar: 'الرمز البريدي' } }),
    city: f.char({ label: { fr: 'Ville', en: 'City', ar: 'المدينة' } }),
    // Generic legal identifiers; the country modules add their own (SIREN, NIF…).
    companyRegistry: f.char({
      label: { fr: 'Immatriculation', en: 'Company registry', ar: 'السجل التجاري' },
    }),
    vat: f.char({ label: { fr: 'N° de TVA', en: 'Tax ID', ar: 'الرقم الضريبي' } }),
    // Accent colour of the web client for this company (checked for contrast by the client).
    accentColor: f.char({ size: 7, default: '#EBFF65' }),
  },
});
