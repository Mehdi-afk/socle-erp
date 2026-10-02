// SPDX-License-Identifier: LGPL-3.0-only
import { defineModel, extendModel, f, type WriteChange } from '@socle/framework';
import type { PersonalDataExport } from '@socle/module-base/privacy';

import { anonymizeThread, exportThread, recordTracking } from '../lib/service.js';

export default [
  defineModel({
    name: 'mail.thread',
    abstract: true,
    methods: (Base) =>
      class extends Base {
        override async afterWrite(changes: readonly WriteChange[]): Promise<void> {
          await super.afterWrite(changes);
          if (this.env.side === 'server') await recordTracking(this.env, this.model, changes);
        }
        override async afterAnonymize(): Promise<void> {
          await super.afterAnonymize();
          if (this.model === 'res.partner') await anonymizeThread(this.env, this.ensureOne().id);
        }
      },
  }),
  extendModel('res.partner', {
    mixins: ['mail.thread'],
    fields: {
      name: f.char({ tracking: true }),
      email: f.char({ tracking: true }),
      phone: f.char({ tracking: true }),
    },
    serverMethods: (Base) =>
      class extends Base {
        override async gdprExport(): Promise<PersonalDataExport> {
          const result = await super.gdprExport();
          return {
            ...result,
            related: { ...result.related, ...(await exportThread(this.env, this.ensureOne().id)) },
          };
        }
      },
  }),
];
