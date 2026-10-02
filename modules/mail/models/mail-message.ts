// SPDX-License-Identifier: LGPL-3.0-only
import { AccessError, defineModel, f, ValidationError } from '@socle/framework';

export default defineModel({
  name: 'mail.message',
  description: { fr: 'Message', en: 'Message', ar: 'رسالة' },
  mixins: ['company.scoped'],
  order: 'id desc',
  // The parent-aware replica is not connected yet; generic sync must never expose these rows.
  offline: { conflict: 'append-only', syncable: false },
  fields: {
    resModel: f.char({ required: true, readonly: true, index: true }),
    resId: f.char({ required: true, readonly: true, index: true }),
    authorId: f.char({ required: true, readonly: true }),
    kind: f.selection(
      [
        ['comment', 'Message'],
        ['note', 'Note interne'],
        ['tracking', 'Modification'],
      ],
      { required: true, readonly: true },
    ),
    body: f.text({ required: true, readonly: true }),
    changes: f.json({ readonly: true }),
  },
  methods: (Base) =>
    class extends Base {
      override write(): Promise<void> {
        return Promise.reject(new ValidationError('Messages are append-only.'));
      }
      override unlink(): Promise<void> {
        return Promise.reject(new ValidationError('Messages are append-only.'));
      }
      async eraseForPrivacy(): Promise<void> {
        if (!this.env.su)
          throw new AccessError('Privacy erasure requires the audited privacy service.');
        await super.write({ body: 'Anonymisé', changes: null });
      }
    },
});
