// SPDX-License-Identifier: LGPL-3.0-only
import type { AccessDefinition } from '@socle/framework';

export default [
  {
    model: 'acc.partner',
    group: 'acc_base.group_user',
    read: true,
    write: true,
    create: true,
    unlink: true,
  },
] satisfies AccessDefinition[];
