// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, f } from '@socle/framework';

export default defineModel({
  name: 'acc.job',
  fields: { label: f.char({ required: true }) },
  serverMethods: (Base) =>
    class extends Base {
      /** Leaves a trace, to see that the task ran. */
      async bump(): Promise<void> {
        await this.create({ label: 'bump' });
      }

      /** Leaves a trace, then fails: the trace must be rolled back. */
      async explode(): Promise<void> {
        await this.create({ label: 'explode' });
        await this.env.flush();
        throw new Error('boom');
      }
    },
});
