// SPDX-License-Identifier: LGPL-3.0-only
//
// The security declarations of a module (its security/ files, the source of truth) as data of
// the base models `res.groups`, `ir.model.access` and `ir.rule`, so that the administration
// screens can show and assign them. Loaded with the module data at every installation and
// upgrade; only for the models that exist (the `base` module installed).
import { defineData, ref, type DataRecord, type ModuleData } from '../orm/data.js';
import type { ModuleSecurity } from './policy.js';

const ALL_OPERATIONS = ['read', 'create', 'write', 'unlink'];

/** `sale.group_user` → `group_user` (the local id of a qualified security id). */
const localId = (qualified: string): string => qualified.slice(qualified.indexOf('.') + 1);

/**
 * Data records mirroring `security`. `hasModel` tells which base models exist.
 * @public
 */
export function securityRecords(
  security: ModuleSecurity,
  hasModel: (model: string) => boolean,
): ModuleData[] {
  const data: ModuleData[] = [];
  if (hasModel('res.groups') && (security.groups ?? []).length > 0) {
    data.push(
      defineData(
        'res.groups',
        (security.groups ?? []).map((group) => ({
          id: localId(group.id),
          values: {
            code: group.id,
            name: { ...group.name },
            impliedIds: (group.implies ?? []).map((implied) => ref(implied)),
          },
        })),
      ),
    );
  }
  if (hasModel('ir.model.access') && (security.access ?? []).length > 0) {
    const records: DataRecord[] = [];
    const used = new Set<string>();
    for (const entry of security.access ?? []) {
      const base = `access_${entry.model.replaceAll('.', '_')}_${entry.group === null ? 'all' : entry.group.replace('.', '_')}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}_${String(n)}`;
      used.add(id);
      records.push({
        id,
        values: {
          modelName: entry.model,
          groupId: entry.group === null ? null : ref(entry.group),
          permRead: entry.read === true,
          permCreate: entry.create === true,
          permWrite: entry.write === true,
          permUnlink: entry.unlink === true,
        },
      });
    }
    data.push(defineData('ir.model.access', records));
  }
  if (hasModel('ir.rule') && (security.rules ?? []).length > 0) {
    data.push(
      defineData(
        'ir.rule',
        (security.rules ?? []).map((rule) => ({
          id: localId(rule.id),
          values: {
            code: rule.id,
            modelName: rule.model,
            domain: JSON.parse(JSON.stringify(rule.domain)) as unknown,
            operations: [...(rule.operations ?? ALL_OPERATIONS)],
            groupIds: (rule.groups ?? []).map((group) => ref(group)),
          },
        })),
      ),
    );
  }
  return data;
}
