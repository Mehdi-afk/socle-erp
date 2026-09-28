// SPDX-License-Identifier: LGPL-3.0-only
//
// Security declarations of the modules (ARCHITECTURE.md §4.8): groups, access rights per model
// and group (ACL), record rules. Everything is refused unless a declaration allows it.
import { SocleError } from '../errors.js';
import type { LocalizedText } from '../registry/manifest.js';
import type { DomainOperator } from '../orm/domain.js';
import type { Operation } from '../orm/environment.js';

/**
 * A security declaration is invalid (unknown group, duplicate id, malformed rule…).
 * @public
 */
export class SecurityDefinitionError extends SocleError {
  constructor(message: string) {
    super('security.definition', message);
  }
}

/**
 * A group of users. `implies`: members also get the rights of these groups
 * (e.g. `sale.group_manager` implies `sale.group_user`).
 * @public
 */
export interface GroupDefinition {
  /** `module.name`, e.g. `sale.group_user`. */
  readonly id: string;
  readonly name: LocalizedText;
  readonly implies?: readonly string[] | undefined;
}

/**
 * Access rights to a model (Odoo's `ir.model.access`): the union of the entries of the
 * user's groups applies; no entry means no access.
 * @public
 */
export interface AccessDefinition {
  readonly model: string;
  /** `null`: every authenticated user. */
  readonly group: string | null;
  readonly read?: boolean | undefined;
  readonly create?: boolean | undefined;
  readonly write?: boolean | undefined;
  readonly unlink?: boolean | undefined;
}

/**
 * A value taken from the acting user when a record rule is evaluated.
 * @public
 */
export interface UserValue {
  readonly $user: 'id' | 'companyId' | 'companyIds' | 'groupIds';
}

/**
 * A condition of a record rule: a domain condition whose value may come from the user.
 * @public
 */
export type RuleCondition = readonly [string, DomainOperator, unknown];

/**
 * A record rule domain, e.g. `[['companyId', 'in', { $user: 'companyIds' }]]`.
 * @public
 */
export type RuleDomain = readonly (RuleCondition | '&' | '|' | '!')[];

/**
 * A record rule (Odoo's `ir.rule`). Global rules (no group) always apply and are combined with
 * AND; group rules apply to members of their groups and are combined with OR.
 * @public
 */
export interface RuleDefinition {
  /** `module.name`, unique. */
  readonly id: string;
  readonly model: string;
  readonly domain: RuleDomain;
  /** Empty or omitted: a global rule. */
  readonly groups?: readonly string[] | undefined;
  /** Operations the rule restricts (default: all four). */
  readonly operations?: readonly Operation[] | undefined;
}

/**
 * The security declarations of one module (its `security/*.ts` files).
 * @public
 */
export interface ModuleSecurity {
  readonly module: string;
  readonly groups?: readonly GroupDefinition[] | undefined;
  readonly access?: readonly AccessDefinition[] | undefined;
  readonly rules?: readonly RuleDefinition[] | undefined;
}

/**
 * The security declarations of every installed module, checked and indexed.
 * @public
 */
export interface SecurityPolicy {
  readonly groups: ReadonlyMap<string, GroupDefinition>;
  /** Access entries per model. */
  readonly access: ReadonlyMap<string, readonly AccessDefinition[]>;
  /** Record rules per model. */
  readonly rules: ReadonlyMap<string, readonly RuleDefinition[]>;
}

const QUALIFIED_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const USER_KEYS = new Set(['id', 'companyId', 'companyIds', 'groupIds']);
const OPERATIONS = new Set<string>(['read', 'create', 'write', 'unlink']);

/**
 * True for a `{ $user: … }` placeholder of a record rule.
 * @public
 */
export function isUserValue(value: unknown): value is UserValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === '$user' &&
    USER_KEYS.has(String((value as { $user: unknown }).$user))
  );
}

function checkId(kind: string, id: string, module: string): void {
  if (!QUALIFIED_ID.test(id)) {
    throw new SecurityDefinitionError(`${kind} id "${id}" must look like "module.name".`);
  }
  if (!id.startsWith(`${module}.`)) {
    throw new SecurityDefinitionError(
      `${kind} "${id}" must be prefixed by its module "${module}".`,
    );
  }
}

/**
 * Checks and indexes the security declarations of the installed modules. `hasModel` rejects
 * declarations about unknown models (typically `registry.has`).
 * @throws {@link SecurityDefinitionError}
 * @public
 */
export function buildSecurityPolicy(
  modules: readonly ModuleSecurity[],
  hasModel: (model: string) => boolean,
): SecurityPolicy {
  const groups = new Map<string, GroupDefinition>();
  const access = new Map<string, AccessDefinition[]>();
  const rules = new Map<string, RuleDefinition[]>();
  const ruleIds = new Set<string>();

  for (const module of modules) {
    for (const group of module.groups ?? []) {
      checkId('Group', group.id, module.module);
      if (groups.has(group.id))
        throw new SecurityDefinitionError(`Group "${group.id}" is declared twice.`);
      groups.set(group.id, group);
    }
  }
  const knownGroup = (id: string, where: string): void => {
    if (!groups.has(id)) throw new SecurityDefinitionError(`${where}: unknown group "${id}".`);
  };
  const knownModel = (model: string, where: string): void => {
    if (!hasModel(model)) throw new SecurityDefinitionError(`${where}: unknown model "${model}".`);
  };

  for (const group of groups.values()) {
    for (const implied of group.implies ?? []) knownGroup(implied, `Group "${group.id}"`);
  }
  for (const module of modules) {
    for (const entry of module.access ?? []) {
      const where = `Access of "${module.module}" on "${entry.model}"`;
      knownModel(entry.model, where);
      if (entry.group !== null) knownGroup(entry.group, where);
      const list = access.get(entry.model) ?? [];
      list.push(Object.freeze({ ...entry }));
      access.set(entry.model, list);
    }
    for (const rule of module.rules ?? []) {
      checkId('Rule', rule.id, module.module);
      if (ruleIds.has(rule.id))
        throw new SecurityDefinitionError(`Rule "${rule.id}" is declared twice.`);
      ruleIds.add(rule.id);
      knownModel(rule.model, `Rule "${rule.id}"`);
      for (const group of rule.groups ?? []) knownGroup(group, `Rule "${rule.id}"`);
      for (const operation of rule.operations ?? []) {
        if (!OPERATIONS.has(operation)) {
          throw new SecurityDefinitionError(`Rule "${rule.id}": unknown operation "${operation}".`);
        }
      }
      for (const term of rule.domain) {
        if (typeof term === 'string') continue;
        const value = term[2];
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          !isUserValue(value)
        ) {
          throw new SecurityDefinitionError(
            `Rule "${rule.id}": a value must be a scalar, a list or { $user: 'id' | 'companyId' | 'companyIds' | 'groupIds' }.`,
          );
        }
      }
      const list = rules.get(rule.model) ?? [];
      list.push(Object.freeze({ ...rule }));
      rules.set(rule.model, list);
    }
  }
  return { groups, access, rules };
}
