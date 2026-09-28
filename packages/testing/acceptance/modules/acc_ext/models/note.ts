// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'acc.note',
  fields: {
    partnerId: f.many2one('acc.partner'),
    body: f.text(),
  },
});
