// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f, ValidationError } from '@socle/framework';

export default [
  defineModel({
    name: 'mail.activity.type',
    description: { fr: 'Type d’activité', en: 'Activity type', ar: 'نوع النشاط' },
    order: 'name',
    fields: {
      name: f.char({
        required: true,
        size: 254,
        translate: true,
        label: { fr: 'Nom', en: 'Name', ar: 'الاسم' },
      }),
      code: f.char({ required: true, size: 64, index: true }),
      color: f.integer({ required: true, default: 1 }),
    },
    unique: [{ name: 'code_unique', fields: ['code'] }],
    constraints: [{ fields: ['color'], check: 'checkColor' }],
    methods: (Base) =>
      class extends Base {
        checkColor(): void {
          for (const record of this)
            if (record.color < 1 || record.color > 8)
              throw new ValidationError('Activity colors range from 1 to 8.');
        }
      },
  }),
  defineModel({
    name: 'mail.activity',
    description: { fr: 'Activité', en: 'Activity', ar: 'نشاط' },
    mixins: ['company.scoped'],
    order: 'dueDate, id',
    offline: { syncable: false },
    fields: {
      resModel: f.char({ required: true, readonly: true, index: true }),
      resId: f.char({ required: true, readonly: true, index: true }),
      summary: f.char({ required: true, size: 254 }),
      typeId: f.many2one('mail.activity.type', { required: true, ondelete: 'restrict' }),
      assignedUserId: f.char({ required: true, readonly: true, index: true }),
      dueDate: f.date({ required: true, index: true }),
      state: f.selection(
        [
          ['planned', 'À faire'],
          ['done', 'Terminée'],
          ['cancelled', 'Annulée'],
        ],
        { required: true, default: 'planned' },
      ),
      feedback: f.text(),
    },
  }),
  defineModel({
    name: 'mail.notification',
    offline: { syncable: false },
    fields: {
      messageId: f.many2one('mail.message', {
        required: true,
        ondelete: 'cascade',
        readonly: true,
      }),
      userId: f.char({ required: true, index: true, readonly: true }),
      isRead: f.boolean({ required: true, default: false }),
    },
    unique: [{ name: 'message_user_unique', fields: ['messageId', 'userId'] }],
  }),
  defineModel({
    name: 'mail.follower',
    mixins: ['company.scoped'],
    offline: { syncable: false },
    fields: {
      resModel: f.char({ required: true, readonly: true, index: true }),
      resId: f.char({ required: true, readonly: true, index: true }),
      userId: f.char({ required: true, readonly: true, index: true }),
    },
    unique: [{ name: 'record_user_unique', fields: ['resModel', 'resId', 'userId'] }],
  }),
];
