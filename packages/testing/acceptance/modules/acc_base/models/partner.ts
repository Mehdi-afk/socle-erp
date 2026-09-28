// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'acc.partner',
  fields: {
    name: f.char({ required: true }),
    city: f.char(),
    score: f.integer(),
  },
});
