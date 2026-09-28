// SPDX-License-Identifier: LGPL-3.0-only
import { defineManifest } from '@socle/framework';

export default defineManifest({
  name: 'acc_ext',
  version: '1.0.0',
  label: { fr: 'Acceptation : extension' },
  depends: ['acc_base'],
  license: 'LGPL-3.0-only',
  edition: 'community',
  engines: { socle: '^0.1.0' },
});
