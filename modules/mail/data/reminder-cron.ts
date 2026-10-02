// SPDX-License-Identifier: LGPL-3.0-only
import { defineData } from '@socle/framework';

export default defineData('ir.cron', [
  {
    id: 'activity_reminders',
    values: {
      name: 'Rappels des activités personnelles',
      modelName: 'mail.activity',
      method: 'remindDue',
      intervalNumber: 15,
      intervalType: 'minutes',
    },
  },
]);
