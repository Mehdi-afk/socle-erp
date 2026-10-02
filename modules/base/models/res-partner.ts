// SPDX-License-Identifier: LGPL-3.0-only
//
// A person or an organisation. Minimal here: the `contacts` module enriches it through
// extendModel (addresses, legal identifiers, tags…).
import { defineModel, f, ValidationError } from '@socle/framework';

import {
  anonymizedValues,
  exportPersonalData,
  reasonText,
  retentionBlocks,
  type PersonalDataExport,
} from '../lib/gdpr.js';

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
  serverMethods: (Base) =>
    class extends Base {
      /** GDPR: everything the user may read about this person (right of access). */
      gdprExport(): Promise<PersonalDataExport> {
        return exportPersonalData(this.env, this.ensureOne().id);
      }

      /**
       * GDPR: erases this person's identifying data (right to erasure). Refused while a legal
       * obligation keeps a record about them, or while they are a user of the system.
       */
      async gdprAnonymize(): Promise<{ readonly anonymized: true }> {
        const partner = this.ensureOne();
        const system = this.env.sudo(`GDPR: checks before anonymising ${partner.id}`);
        const blocks = await retentionBlocks(system, partner.id, new Date());
        if (blocks.length > 0) {
          const reasons = blocks.map(
            (block) =>
              `${reasonText(block.reason, this.env.user.lang)} (${String(block.count)} × ${block.model})`,
          );
          throw new ValidationError(
            `This person cannot be anonymised: a legal obligation keeps records about them — ${reasons.join('; ')}.`,
          );
        }
        if (
          system.registry.has('res.users') &&
          (await system.model('res.users').searchCount([['partnerId', '=', partner.id]])) > 0
        ) {
          throw new ValidationError('This person is a user: remove the user account first.');
        }
        await partner.write(anonymizedValues(this.env.registry.get('res.partner')));
        await partner.afterAnonymize();
        return { anonymized: true };
      }
    },
});
