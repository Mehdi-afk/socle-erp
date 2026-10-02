// SPDX-License-Identifier: LGPL-3.0-only
// Polymorphic record data is only exposed by the parent-aware service, even to administrators.
import type { AccessDefinition } from '@socle/framework';

export default [
  { model: 'mail.activity.type', group: 'base.group_user', read: true },
  {
    model: 'mail.activity.type',
    group: 'base.group_system',
    read: true,
    create: true,
    write: true,
    unlink: true,
  },
] satisfies AccessDefinition[];
