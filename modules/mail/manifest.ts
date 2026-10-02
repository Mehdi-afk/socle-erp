// SPDX-License-Identifier: LGPL-3.0-only
import { defineManifest } from '@socle/framework';

export default defineManifest({
  name: 'mail',
  version: '0.1.1',
  label: {
    fr: 'Échanges et activités',
    en: 'Conversations and activities',
    ar: 'المحادثات والأنشطة',
  },
  category: 'Productivité',
  license: 'LGPL-3.0-only',
  edition: 'community',
  engines: { socle: '^0.1.0' },
  depends: ['base'],
  capabilities: ['cron'],
});
