// SPDX-License-Identifier: LGPL-3.0-only
//
// PostgreSQL row-level security, the second line of defence behind the ORM (ARCHITECTURE.md
// §4.8, §9.3). Every table of a model with record rules gets one policy per command that
// mirrors the rules, reading the acting user from the transaction settings written by the
// storage (`SET LOCAL app.user_id`, …):
//
//   su  OR  (user set  AND  global rules  AND  (no group rule applies  OR  one applying rule))
//
// A rule that cannot be expressed without querying other tables (paths through relations) is
// replaced with TRUE: the policy may be looser than the ORM, never stricter — the ORM stays
// the first line and always applies every rule.
import {
  effectiveGroups,
  isUserValue,
  parseDomain,
  type DomainNode,
  type ModelRegistry,
  type Operation,
  type RuleDefinition,
  type RuleDomain,
  type SecurityPolicy,
} from '@socle/framework';
import { sql, type RawBuilder, type SqlBool, type Transaction } from 'kysely';

import { DomainCompiler, NotMirrorable, SessionValue } from './compile.js';
import type { Tables } from './database.js';
import { SchemaError } from './errors.js';
import { identifier } from './naming.js';

type Predicate = RawBuilder<SqlBool>;

const COMMANDS: readonly (readonly [Operation, 'select' | 'insert' | 'update' | 'delete'])[] = [
  ['read', 'select'],
  ['create', 'insert'],
  ['write', 'update'],
  ['unlink', 'delete'],
];

const SENTINEL = '\u0000socle:user:';

export interface RowPolicy {
  readonly table: string;
  readonly command: 'select' | 'insert' | 'update' | 'delete';
  readonly expression: Predicate;
}

export interface RowSecurityPlan {
  /** Tables with row-level security (models having record rules). */
  readonly tables: readonly string[];
  readonly policies: readonly RowPolicy[];
  /** Rules only partly mirrored (replaced with TRUE in the policies), with the reason. */
  readonly approximated: readonly string[];
}

const setting = (name: string): RawBuilder<unknown> =>
  sql`coalesce(current_setting(${sql.lit(name)}, true), '')`;

/** The rule domain with `$user` values turned into session reads. */
function policyDomain(registry: ModelRegistry, rule: RuleDefinition): DomainNode {
  // Placeholders become sentinels the parser accepts, then SessionValue objects.
  const template = rule.domain.map((term) => {
    if (typeof term === 'string' || !isUserValue(term[2])) return term;
    const key = term[2].$user;
    const list = key === 'companyIds' || key === 'groupIds';
    return [term[0], term[1], list ? [`${SENTINEL}${key}`] : `${SENTINEL}${key}`] as const;
  }) as RuleDomain;
  const node = parseDomain(template, rule.model, (model, field) => registry.field(model, field));
  const restore = (current: DomainNode): DomainNode => {
    switch (current.kind) {
      case 'true':
        return current;
      case 'and':
      case 'or':
        return { kind: current.kind, children: current.children.map(restore) };
      case 'not':
        return { kind: 'not', child: restore(current.child) };
      case 'condition': {
        const value: unknown = current.value;
        const single = Array.isArray(value) && value.length === 1 ? (value[0] as unknown) : value;
        if (typeof single === 'string' && single.startsWith(SENTINEL)) {
          const key = single.slice(SENTINEL.length) as SessionValue['key'];
          return { ...current, value: new SessionValue(key) };
        }
        return current;
      }
    }
  };
  return restore(node);
}

function or(parts: readonly Predicate[]): Predicate {
  if (parts.length === 0) return sql<SqlBool>`false`;
  return sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

function and(parts: readonly Predicate[]): Predicate {
  if (parts.length === 0) return sql<SqlBool>`true`;
  return sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

/**
 * The policies mirroring the record rules of `security` (pure: nothing is executed).
 * @throws {@link SchemaError} for a rule on an unknown model
 */
export function buildRowSecurity(
  registry: ModelRegistry,
  security: SecurityPolicy,
): RowSecurityPlan {
  const approximated: string[] = [];
  const policies: RowPolicy[] = [];
  const tables: string[] = [];

  // Groups that grant membership of each group through `implies` (reverse closure): the
  // policy only needs the user's own groups.
  const granting = new Map<string, string[]>();
  for (const candidate of security.groups.keys()) {
    for (const granted of effectiveGroups(security, [candidate])) {
      const list = granting.get(granted) ?? [];
      list.push(candidate);
      granting.set(granted, list);
    }
  }
  const userGroups = sql`string_to_array(${setting('app.group_ids')}, ',')`;
  const member = (groups: readonly string[]): Predicate => {
    const all = [...new Set(groups.flatMap((group) => granting.get(group) ?? [group]))].sort();
    return sql<SqlBool>`(${userGroups} && array[${sql.join(all.map((group) => sql.lit(group)))}]::text[])`;
  };
  const su = sql<SqlBool>`${setting('app.su')} = 'on'`;
  const userSet = sql<SqlBool>`${setting('app.user_id')} <> ''`;

  for (const [model, rules] of [...security.rules].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!registry.has(model)) throw new SchemaError(`Rules on unknown model "${model}".`);
    const meta = registry.get(model);
    if (meta.abstract || rules.length === 0) continue;
    const table = identifier(meta.table);
    tables.push(table);

    const mirrored = (rule: RuleDefinition): Predicate => {
      try {
        return new DomainCompiler(registry, 'policy').compile(
          meta,
          table,
          policyDomain(registry, rule),
        );
      } catch (error) {
        if (!(error instanceof NotMirrorable)) throw error;
        if (!approximated.some((entry) => entry.startsWith(`${rule.id}:`))) {
          approximated.push(`${rule.id}: ${error.message}`);
        }
        return sql<SqlBool>`true`;
      }
    };

    for (const [operation, command] of COMMANDS) {
      const applicable = rules.filter((rule) =>
        (rule.operations ?? ['read', 'create', 'write', 'unlink']).includes(operation),
      );
      const global = applicable.filter((rule) => (rule.groups ?? []).length === 0).map(mirrored);
      const grouped = applicable.filter((rule) => (rule.groups ?? []).length > 0);
      const parts = [...global];
      if (grouped.length > 0) {
        const anyApplies = or(grouped.map((rule) => member(rule.groups ?? [])));
        parts.push(
          or([
            sql<SqlBool>`not ${anyApplies}`,
            ...grouped.map((rule) => and([member(rule.groups ?? []), mirrored(rule)])),
          ]),
        );
      }
      policies.push({ table, command, expression: or([su, and([userSet, ...parts])]) });
    }
  }
  return { tables, policies, approximated };
}

/**
 * Replaces the row-level security managed by Socle (policies named `socle_*`) with `plan`,
 * inside the schema transaction.
 */
export async function applyRowSecurity(
  trx: Transaction<Tables>,
  plan: RowSecurityPlan,
): Promise<void> {
  // Literals are only safe with standard strings (backslashes not interpreted).
  const standard = await sql<{
    value: string;
  }>`select current_setting('standard_conforming_strings') as value`.execute(trx);
  if (standard.rows[0]?.value !== 'on') {
    throw new SchemaError(
      'standard_conforming_strings must be on to create row-level security policies.',
    );
  }
  const existing = await sql<{
    table: string;
    name: string;
  }>`select tablename as table, policyname as name from pg_policies where schemaname = current_schema() and starts_with(policyname, 'socle_')`.execute(
    trx,
  );
  for (const { table, name } of existing.rows) {
    await sql`drop policy ${sql.id(name)} on ${sql.table(identifier(table))}`.execute(trx);
  }
  for (const table of new Set(existing.rows.map((row) => row.table))) {
    if (!plan.tables.includes(table)) {
      await sql`alter table ${sql.table(identifier(table))} no force row level security`.execute(
        trx,
      );
      await sql`alter table ${sql.table(identifier(table))} disable row level security`.execute(
        trx,
      );
    }
  }
  for (const table of plan.tables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(trx);
    // FORCE: the policies also apply to the owner of the tables (the application's role).
    await sql`alter table ${sql.table(table)} force row level security`.execute(trx);
  }
  for (const policy of plan.policies) {
    const name = sql.id(`socle_${policy.command}`);
    const on = sql.table(policy.table);
    const ddl =
      policy.command === 'insert'
        ? sql`create policy ${name} on ${on} for insert with check (${policy.expression})`
        : policy.command === 'update'
          ? sql`create policy ${name} on ${on} for update using (${policy.expression}) with check (${policy.expression})`
          : policy.command === 'select'
            ? sql`create policy ${name} on ${on} for select using (${policy.expression})`
            : sql`create policy ${name} on ${on} for delete using (${policy.expression})`;
    const compiled = ddl.compile(trx);
    // DDL cannot carry bound parameters: every value must have been turned into a literal.
    if (compiled.parameters.length > 0) {
      throw new SchemaError(`Policy on "${policy.table}" would need bound parameters.`);
    }
    await trx.executeQuery(compiled);
  }
}
