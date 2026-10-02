// SPDX-License-Identifier: LGPL-3.0-only
import type { UserContext } from '../orm/environment.js';
import { isStoredColumn, type FieldDefinition } from '../orm/fields.js';
import type { ModelRegistry } from '../orm/model-registry.js';
import type { LocalizedText } from '../registry/manifest.js';
import { canAccessModel, canSeeField, effectiveGroups } from '../security/permissions.js';
import type { SecurityPolicy } from '../security/policy.js';
import type { ViewAttribute, ViewNode } from '../views/nodes.js';
import type { ViewRegistry } from '../views/view.js';
import { nodeTypes, referencesClosed, tones, widgets, type SnapshotNodeType } from './schema.js';
import { parseRegistrySnapshot } from './snapshot.js';
import type { FieldSnapshot, ModelSnapshot, RegistrySnapshot, ViewSnapshot } from './types.js';

const localized = (value: LocalizedText): LocalizedText => ({
  fr: value.fr,
  ...(value.en === undefined ? {} : { en: value.en }),
  ...(value.ar === undefined ? {} : { ar: value.ar }),
});

function projectField(name: string, field: FieldDefinition, write: boolean): FieldSnapshot {
  const stored = isStoredColumn(field);
  return {
    name,
    type: field.type,
    stored,
    readonly:
      !write ||
      !stored ||
      field.readonly === true ||
      field.compute !== undefined ||
      field.related !== undefined ||
      field.sensitive === true,
    ...(field.label === undefined ? {} : { label: localized(field.label) }),
    ...(field.help === undefined ? {} : { help: localized(field.help) }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.sensitive === undefined ? {} : { sensitive: field.sensitive }),
    ...(field.type !== 'char' || field.size === undefined ? {} : { size: field.size }),
    ...(field.type !== 'selection' || field.selection === undefined
      ? {}
      : { selection: field.selection.map(([key, label]) => [key, label] as const) }),
    ...(field.comodel === undefined ? {} : { comodel: field.comodel }),
    ...(field.type !== 'one2many' || field.inverse === undefined ? {} : { inverse: field.inverse }),
    ...(field.type !== 'decimal' || field.digits === undefined
      ? {}
      : { digits: [field.digits[0], field.digits[1]] as const }),
    ...(field.type !== 'monetary' ? {} : { currencyField: field.currencyField ?? 'currencyId' }),
  };
}

function projectArch(
  arch: ViewNode,
  initialModel: ModelSnapshot,
  models: ReadonlyMap<string, ModelSnapshot>,
  groups: ReadonlySet<string>,
): ViewNode | undefined {
  const walk = (current: ViewNode, model: ModelSnapshot): ViewNode | undefined => {
    if (!nodeTypes.includes(current.type as SnapshotNodeType)) return undefined;
    const restricted = current.attrs.groups;
    if (
      restricted !== undefined &&
      (!Array.isArray(restricted) ||
        !restricted.every((group) => typeof group === 'string') ||
        !restricted.some((group) => typeof group === 'string' && groups.has(group)))
    )
      return undefined;
    const attrs: Record<string, ViewAttribute> = {};
    const copyString = (name: string): void => {
      const value = current.attrs[name];
      if (typeof value === 'string') attrs[name] = value;
    };
    const copyLabel = (): void => {
      const label = current.attrs.label;
      if (
        label &&
        typeof label === 'object' &&
        !Array.isArray(label) &&
        typeof (label as { fr?: unknown }).fr === 'string'
      ) {
        attrs.label = localized(label as LocalizedText);
      }
    };
    let childModel = model;
    let sourceChildren = current.children;
    switch (current.type) {
      case 'field': {
        const field = model.fields.find((candidate) => candidate.name === current.attrs.name);
        if (!field) return undefined;
        attrs.name = field.name;
        copyLabel();
        if (
          typeof current.attrs.widget === 'string' &&
          (widgets as readonly string[]).includes(current.attrs.widget)
        )
          attrs.widget = current.attrs.widget;
        if (typeof current.attrs.readonly === 'boolean') attrs.readonly = current.attrs.readonly;
        const declaredTones = current.attrs.tones;
        if (declaredTones && typeof declaredTones === 'object' && !Array.isArray(declaredTones)) {
          attrs.tones = Object.fromEntries(
            Object.entries(declaredTones).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string' && (tones as readonly string[]).includes(entry[1]),
            ),
          );
        }
        if (field.type === 'one2many' && field.comodel !== undefined) {
          const target = models.get(field.comodel);
          if (!target) return undefined;
          childModel = target;
          sourceChildren = current.children.filter((child) => child.type === 'list');
        } else sourceChildren = [];
        break;
      }
      case 'header':
        for (const name of ['title', 'subtitle', 'avatar']) {
          const field = model.fields.find((candidate) => candidate.name === current.attrs[name]);
          if (field && !field.sensitive) attrs[name] = field.name;
        }
        break;
      case 'button':
        copyString('name');
        copyLabel();
        if (typeof current.attrs.primary === 'boolean') attrs.primary = current.attrs.primary;
        sourceChildren = [];
        break;
      case 'group':
      case 'page':
        copyString('name');
        copyLabel();
        break;
    }
    const children = sourceChildren.flatMap((child) => {
      const projected = walk(child, childModel);
      return projected ? [projected] : [];
    });
    // An empty relation triggers an implicit list in the renderer. Do not recreate a hidden
    // explicitly declared subview through that fallback.
    if (current.type === 'field' && sourceChildren.length > 0 && children.length === 0)
      return undefined;
    return {
      type: current.type,
      attrs,
      children,
    };
  };
  return walk(arch, initialModel);
}

/**
 * Project composed metadata for one user. The allow-list excludes implementation code,
 * defaults, constraints, record rules, group identifiers and private dependency paths.
 * Permissions only shape the interface; every operation remains authorized by the server.
 * @public
 */
export function createRegistrySnapshot(options: {
  readonly registry: ModelRegistry;
  readonly views?: ViewRegistry;
  readonly security: SecurityPolicy;
  readonly user: UserContext;
}): RegistrySnapshot {
  const { registry, views, security, user } = options;
  const groups = effectiveGroups(security, user.groupIds);
  const models = new Map<string, ModelSnapshot>();
  for (const name of registry.names()) {
    const meta = registry.get(name);
    if (meta.abstract || !canAccessModel(security, groups, name, 'read')) continue;
    const permissions = {
      create: canAccessModel(security, groups, name, 'create'),
      write: canAccessModel(security, groups, name, 'write'),
      unlink: canAccessModel(security, groups, name, 'unlink'),
    };
    models.set(name, {
      name,
      ...(meta.description === undefined ? {} : { description: localized(meta.description) }),
      permissions,
      fields: [...meta.fields]
        .filter(([, field]) => canSeeField(groups, field))
        .map(([name, field]) => projectField(name, field, permissions.write)),
      order: meta.order.map((term) => ({ ...term })),
    });
  }
  // Removing a hidden inverse or currency may invalidate another field. Reach a fixed point.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, model] of models) {
      const fields = model.fields.filter((field) => referencesClosed(field, model, models));
      if (fields.length !== model.fields.length) {
        models.set(name, { ...model, fields });
        changed = true;
      }
    }
  }
  for (const [name, model] of models) {
    const available = new Set(
      model.fields.filter((field) => field.stored).map((field) => field.name),
    );
    const order = model.order.filter(
      (term, index, terms) =>
        available.has(term.field) &&
        terms.findIndex((prior) => prior.field === term.field) === index,
    );
    models.set(name, {
      ...model,
      order: order.length ? order : [{ field: 'id', direction: 'asc' }],
    });
  }
  const projectedViews: ViewSnapshot[] = [];
  for (const id of views?.ids() ?? []) {
    const view = views?.get(id);
    if (!view || (view.type !== 'form' && view.type !== 'list')) continue;
    const model = models.get(view.model);
    if (!model) continue;
    const arch = projectArch(view.arch, model, models, groups);
    if (arch)
      projectedViews.push({
        id: view.id,
        model: view.model,
        type: view.type,
        priority: view.priority,
        arch,
      });
  }
  return parseRegistrySnapshot({
    version: 1,
    userId: user.id,
    companyId: user.companyId,
    models: [...models.values()],
    views: projectedViews,
  });
}
