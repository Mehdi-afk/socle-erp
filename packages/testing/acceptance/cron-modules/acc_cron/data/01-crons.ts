// SPDX-License-Identifier: LGPL-3.0-only
import { defineData } from '@socle/framework';

const past = '2026-01-01T00:00:00.000Z';

export default defineData('ir.cron', [
  {
    id: 'bump',
    values: { name: 'Bump', modelName: 'acc.job', method: 'bump', nextCall: past },
  },
  {
    id: 'explode',
    values: { name: 'Explode', modelName: 'acc.job', method: 'explode', nextCall: past },
  },
  // Not a server method: refused, whatever the capabilities.
  {
    id: 'unlink',
    values: { name: 'Unlink', modelName: 'acc.job', method: 'unlink', nextCall: past },
  },
]);
