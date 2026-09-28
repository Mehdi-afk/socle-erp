// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'acc.partner',
  fields: {
    name: f.char({ required: true }),
    city: f.char(),
    score: f.integer(),
  },
  // Runs on the server only: called offline, it is queued as an intent.
  serverMethods: (Base) =>
    class extends Base {
      async actionPromote(): Promise<void> {
        await this.write({ score: 100 });
        await this.env.flush();
      }
    },
});
