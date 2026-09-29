// SPDX-License-Identifier: LGPL-3.0-only
//
// Scheduled tasks (Odoo's ir.cron) and their run log. A task calls a server method of a model,
// without argument, as the system, at a fixed interval; the worker queues it with pg-boss and
// runs it under a lock, so it never runs twice at the same time. Tasks come from module data
// only: the module that declares one must have the `cron` capability, and the method must be a
// server method of the model. Administrators may pause a task or change its schedule.
import { defineModel, f, ValidationError } from '@socle/framework';

const cron = defineModel({
  name: 'ir.cron',
  description: { fr: 'Tâche planifiée', en: 'Scheduled task', ar: 'مهمة مجدولة' },
  order: 'name',
  offline: { syncable: false },
  constraints: [{ fields: ['intervalNumber'], check: 'checkInterval' }],
  fields: {
    name: f.char({ required: true, label: { fr: 'Nom', en: 'Name', ar: 'الاسم' } }),
    modelName: f.char({
      required: true,
      readonly: true,
      label: { fr: 'Modèle', en: 'Model', ar: 'النموذج' },
    }),
    method: f.char({
      required: true,
      readonly: true,
      label: { fr: 'Méthode', en: 'Method', ar: 'الطريقة' },
    }),
    active: f.boolean({ default: true, label: { fr: 'Active', en: 'Active', ar: 'نشطة' } }),
    intervalNumber: f.integer({
      default: 1,
      label: { fr: 'Toutes les', en: 'Every', ar: 'كل' },
    }),
    intervalType: f.selection(
      [
        ['minutes', 'Minutes'],
        ['hours', 'Heures'],
        ['days', 'Jours'],
        ['weeks', 'Semaines'],
        ['months', 'Mois'],
      ],
      { default: 'days', required: true, label: { fr: 'Unité', en: 'Unit', ar: 'الوحدة' } },
    ),
    nextCall: f.datetime({
      required: true,
      default: () => new Date().toISOString(),
      label: { fr: 'Prochaine exécution', en: 'Next run', ar: 'التنفيذ القادم' },
    }),
    lastCall: f.datetime({
      readonly: true,
      label: { fr: 'Dernière exécution', en: 'Last run', ar: 'آخر تنفيذ' },
    }),
    runIds: f.one2many('ir.cron.run', 'cronId', {
      label: { fr: 'Journal', en: 'Log', ar: 'السجل' },
    }),
  },
  methods: (Base) =>
    class extends Base {
      async checkInterval(): Promise<void> {
        await this.prefetch(['intervalNumber']);
        for (const task of this) {
          const n = task.intervalNumber;
          if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) {
            throw new ValidationError('The interval must be a whole number from 1 to 10 000.');
          }
        }
      }
    },
});

const run = defineModel({
  name: 'ir.cron.run',
  description: { fr: 'Exécution de tâche', en: 'Task run', ar: 'تنفيذ مهمة' },
  order: 'startedAt desc',
  offline: { syncable: false },
  fields: {
    cronId: f.many2one('ir.cron', {
      required: true,
      readonly: true,
      index: true,
      ondelete: 'cascade',
      label: { fr: 'Tâche', en: 'Task', ar: 'المهمة' },
    }),
    startedAt: f.datetime({
      required: true,
      readonly: true,
      label: { fr: 'Début', en: 'Start', ar: 'البداية' },
    }),
    endedAt: f.datetime({ readonly: true, label: { fr: 'Fin', en: 'End', ar: 'النهاية' } }),
    status: f.selection(
      [
        ['success', 'Réussie'],
        ['failure', 'Échouée'],
        ['refused', 'Refusée'],
      ],
      { required: true, readonly: true, label: { fr: 'Résultat', en: 'Result', ar: 'النتيجة' } },
    ),
    /** The error, without stack trace (at most 500 characters). */
    message: f.char({ readonly: true, label: { fr: 'Message', en: 'Message', ar: 'الرسالة' } }),
  },
});

export default [cron, run];
