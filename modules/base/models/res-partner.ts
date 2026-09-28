// SPDX-License-Identifier: LGPL-3.0-only
//
// A person or an organisation. Minimal here: the `contacts` module enriches it through
// extendModel (addresses, legal identifiers, tags…).
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'res.partner',
  description: { fr: 'Contact', en: 'Contact', ar: 'جهة اتصال' },
  mixins: ['company.scoped'],
  order: 'name',
  fields: {
    name: f.char({ required: true, index: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    kind: f.selection(
      [
        ['person', 'Personne'],
        ['company', 'Société'],
      ],
      { default: 'person', label: { fr: 'Type', en: 'Type', ar: 'النوع' } },
    ),
    email: f.char({ label: { fr: 'E-mail', en: 'Email', ar: 'البريد الإلكتروني' } }),
    phone: f.char({ label: { fr: 'Téléphone', en: 'Phone', ar: 'الهاتف' } }),
    street: f.char({ label: { fr: 'Rue', en: 'Street', ar: 'الشارع' } }),
    street2: f.char({ label: { fr: 'Complément', en: 'Street 2', ar: 'العنوان 2' } }),
    zip: f.char({ label: { fr: 'Code postal', en: 'ZIP', ar: 'الرمز البريدي' } }),
    city: f.char({ label: { fr: 'Ville', en: 'City', ar: 'المدينة' } }),
    stateId: f.many2one('res.country.state', {
      label: { fr: 'Région / wilaya', en: 'State', ar: 'الولاية' },
    }),
    countryId: f.many2one('res.country', { label: { fr: 'Pays', en: 'Country', ar: 'البلد' } }),
    active: f.boolean({ default: true, label: { fr: 'Actif', en: 'Active', ar: 'نشط' } }),
  },
});
