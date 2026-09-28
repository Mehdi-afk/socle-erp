// SPDX-License-Identifier: LGPL-3.0-only
//
// Permissions as pure functions (FleetOra pattern `canAccessView` / `canWrite`): same inputs,
// same answer, no I/O — testable on their own and shared by the server and the client (which
// only uses them to adapt the interface; every decision is taken again on the server).
import { parseDomain, type Domain, type DomainNode, type FieldResolver } from '../orm/domain.js';
import type { Operation, UserContext } from '../orm/environment.js';
import type { FieldDefinition } from '../orm/fields.js';
import { isUserValue, type RuleDomain, type SecurityPolicy } from './policy.js';

/**
 * The user's groups plus every group they imply, transitively (cycles are harmless).
 * @public
 */
export function effectiveGroups(
  policy: SecurityPolicy,
  groupIds: readonly string[],
): ReadonlySet<string> {
  const result = new Set<string>();
  const pending = [...groupIds];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(policy.groups.get(id)?.implies ?? []));
  }
  return result;
}

/**
 * ACL: true when at least one access entry of the model, for everyone or for one of the
 * groups, grants the operation. No entry: refused (deny by default).
 * @public
 */
export function canAccessModel(
  policy: SecurityPolicy,
  groups: ReadonlySet<string>,
  model: string,
  operation: Operation,
): boolean {
  return (policy.access.get(model) ?? []).some(
    (entry) => (entry.group === null || groups.has(entry.group)) && entry[operation] === true,
  );
}

/**
 * A field restricted with `groups` is only visible to members of one of them.
 * @public
 */
export function canSeeField(groups: ReadonlySet<string>, definition: FieldDefinition): boolean {
  return definition.groups === undefined || definition.groups.some((group) => groups.has(group));
}

/**
 * Replaces the `{ $user: … }` placeholders of a record rule with the user's values.
 * @public
 */
export function resolveRuleDomain(domain: RuleDomain, user: UserContext): Domain {
  return domain.map((term) => {
    if (typeof term === 'string') return term;
    const [path, operator, value] = term;
    if (!isUserValue(value)) return term;
    const resolved: string | readonly string[] | null = user[value.$user];
    return [
      path,
      operator,
      typeof resolved === 'object' && resolved !== null ? [...resolved] : resolved,
    ] as const;
  });
}

const TRUE: DomainNode = { kind: 'true' };

function combine(kind: 'and' | 'or', nodes: readonly DomainNode[]): DomainNode {
  if (nodes.length === 0) return TRUE;
  if (nodes.length === 1) return nodes[0] as DomainNode;
  return { kind, children: nodes };
}

/**
 * The record-rule domain of an operation for a user, Odoo semantics: every global rule
 * (AND) and, when some group rules concern the user, at least one of them (OR).
 * `{ kind: 'true' }` when no rule applies.
 * @public
 */
export function ruleDomainFor(
  policy: SecurityPolicy,
  user: UserContext,
  groups: ReadonlySet<string>,
  model: string,
  operation: Operation,
  resolve: FieldResolver,
): DomainNode {
  const rules = (policy.rules.get(model) ?? []).filter((rule) =>
    (rule.operations ?? ['read', 'create', 'write', 'unlink']).includes(operation),
  );
  const parse = (domain: RuleDomain): DomainNode =>
    parseDomain(resolveRuleDomain(domain, user), model, resolve);
  const global = rules
    .filter((rule) => (rule.groups ?? []).length === 0)
    .map((rule) => parse(rule.domain));
  const grouped = rules
    .filter((rule) => (rule.groups ?? []).some((group) => groups.has(group)))
    .map((rule) => parse(rule.domain));
  const parts = [...global];
  if (grouped.length > 0) parts.push(combine('or', grouped));
  return combine('and', parts);
}
