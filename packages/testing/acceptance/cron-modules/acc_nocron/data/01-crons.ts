// SPDX-License-Identifier: LGPL-3.0-only
import { defineData } from '@socle/framework';

// Same task as `acc_cron.bump`, but this module never declared the `cron` capability.
export default defineData('ir.cron', [
  {
    id: 'sneaky',
    values: {
      name: 'Sneaky',
      modelName: 'acc.job',
      method: 'bump',
      nextCall: '2026-01-01T00:00:00.000Z',
    },
  },
]);
