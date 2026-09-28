// SPDX-License-Identifier: LGPL-3.0-only
import type { GroupDefinition } from '@socle/framework';

export default [
  {
    id: 'base.group_user',
    name: { fr: 'Utilisateur interne', en: 'Internal user', ar: 'مستخدم داخلي' },
  },
  {
    id: 'base.group_erp_manager',
    name: { fr: 'Gestion des accès', en: 'Access rights', ar: 'إدارة الصلاحيات' },
    implies: ['base.group_user'],
  },
  {
    id: 'base.group_system',
    name: { fr: 'Administration', en: 'Administration', ar: 'الإدارة' },
    implies: ['base.group_erp_manager'],
  },
] satisfies GroupDefinition[];
