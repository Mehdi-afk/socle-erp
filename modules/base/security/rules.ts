// SPDX-License-Identifier: LGPL-3.0-only
import type { RuleDefinition } from '@socle/framework';

export default [
  // Declared once on the mixin: applies to every company-scoped model of every module, in the
  // ORM and in PostgreSQL row-level security. An empty company means shared by all companies.
  {
    id: 'base.company_scoped',
    model: 'company.scoped',
    domain: ['|', ['companyId', '=', null], ['companyId', 'in', { $user: 'companyIds' }]],
  },
  // A user only sees and changes the companies they are allowed in.
  {
    id: 'base.company_allowed',
    model: 'res.company',
    domain: [['id', 'in', { $user: 'companyIds' }]],
    operations: ['read', 'write', 'unlink'],
  },
] satisfies RuleDefinition[];
