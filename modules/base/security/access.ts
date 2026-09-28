// SPDX-License-Identifier: LGPL-3.0-only
import type { AccessDefinition } from '@socle/framework';

const read = { read: true } as const;
const all = { read: true, create: true, write: true, unlink: true } as const;

export default [
  // Companies: everyone reads theirs, access managers create and edit, administrators delete.
  { model: 'res.company', group: 'base.group_user', ...read },
  { model: 'res.company', group: 'base.group_erp_manager', create: true, write: true },
  { model: 'res.company', group: 'base.group_system', unlink: true },
  { model: 'res.partner', group: 'base.group_user', ...all },
  { model: 'res.users', group: 'base.group_user', ...read },
  { model: 'res.users', group: 'base.group_erp_manager', ...all },
  // Mirrors of the security declarations: shown, never edited by hand.
  { model: 'res.groups', group: 'base.group_user', ...read },
  { model: 'ir.model.access', group: 'base.group_erp_manager', ...read },
  { model: 'ir.rule', group: 'base.group_erp_manager', ...read },
  // Reference data: read by everyone, maintained by administrators.
  { model: 'res.currency', group: 'base.group_user', ...read },
  { model: 'res.currency', group: 'base.group_system', ...all },
  { model: 'res.currency.rate', group: 'base.group_user', ...read },
  { model: 'res.currency.rate', group: 'base.group_system', ...all },
  { model: 'res.country', group: 'base.group_user', ...read },
  { model: 'res.country', group: 'base.group_system', ...all },
  { model: 'res.country.state', group: 'base.group_user', ...read },
  { model: 'res.country.state', group: 'base.group_system', ...all },
  { model: 'res.city', group: 'base.group_user', ...read },
  { model: 'res.city', group: 'base.group_system', ...all },
  { model: 'ir.config_parameter', group: 'base.group_system', ...all },
  // Sequences: numbers are taken by business code (usually through sudo), set up by admins.
  { model: 'ir.sequence', group: 'base.group_user', ...read },
  { model: 'ir.sequence', group: 'base.group_system', ...all },
] satisfies AccessDefinition[];
