// SPDX-License-Identifier: LGPL-3.0-only
//
// Declarative views and view inheritance (ARCHITECTURE.md §4.5): a module defines a view, other
// modules change it with selectors. A selector that finds nothing — or finds several nodes —
// is an error when the registry is built (installation), never a silent failure.
import type { ModelRegistry } from '../orm/model-registry.js';
import { canSeeField } from '../security/permissions.js';
import type { ViewAttribute, ViewNode } from './nodes.js';
import { parseSelector, ViewError, type SelectorStep } from './selector.js';

/**
 * View types (`gantt` and `map`: phase 5).
 * @public
 */
export type ViewType =
  'form' | 'list' | 'kanban' | 'calendar' | 'pivot' | 'graph' | 'search' | 'gantt' | 'map';

const VIEW_TYPES = new Set<string>([
  'form',
  'list',
  'kanban',
  'calendar',
  'pivot',
  'graph',
  'search',
  'gantt',
  'map',
]);

/** Node types the view engine renders; anything else is refused (typos surface at install). */
const NODE_TYPES = new Set<string>([
  ...VIEW_TYPES,
  'header',
  'sheet',
  'group',
  'notebook',
  'page',
  'field',
  'button',
  'filter',
  'separator',
  'label',
  'div',
]);

/** @public */
export interface ViewDefinition {
  readonly kind: 'define';
  /** `module.name`, e.g. `sale.order.form`. */
  readonly id: string;
  readonly model: string;
  readonly type: ViewType;
  readonly arch: ViewNode;
  /** The default view of its type for the model is the one with the lowest priority. */
  readonly priority: number;
}

/**
 * Where an extension puts its nodes relative to the node found by `at`.
 * @public
 */
export type ViewPosition = 'before' | 'after' | 'inside' | 'replace' | 'attributes';

/** @public */
export interface ViewChange {
  /** Selector of exactly one node, e.g. `group[name='totals'] > field[name='amountUntaxed']`. */
  readonly at: string;
  readonly position: ViewPosition;
  /** Nodes to insert (before, after, inside) or to put instead (replace; none = removal). */
  readonly node?: ViewNode | undefined;
  readonly nodes?: readonly ViewNode[] | undefined;
  /** For `attributes`: values to set, `null` to remove. */
  readonly attributes?: Readonly<Record<string, ViewAttribute>> | undefined;
}

/** @public */
export interface ViewExtension {
  readonly kind: 'extend';
  readonly view: string;
  readonly changes: readonly ViewChange[];
}

const VIEW_ID_SEGMENT = /^[a-z][a-z0-9_]*$/;

/** `module.name…`: at least two dotted lowercase segments (checked per segment, no nested quantifier). */
const isViewId = (id: string): boolean => {
  const segments = id.split('.');
  return (
    id.length <= 128 && segments.length >= 2 && segments.every((part) => VIEW_ID_SEGMENT.test(part))
  );
};

const describe = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/**
 * Declares a view.
 * @throws {@link ViewError}
 * @public
 */
export function defineView(input: {
  readonly id: string;
  readonly model: string;
  readonly type: ViewType;
  readonly arch: ViewNode;
  readonly priority?: number | undefined;
}): ViewDefinition {
  if (!isViewId(input.id)) throw new ViewError(`Invalid view id "${input.id}".`);
  if (!VIEW_TYPES.has(input.type))
    throw new ViewError(`View "${input.id}": unknown type "${input.type}".`);
  if (input.arch.type !== input.type) {
    throw new ViewError(
      `View "${input.id}": the root node must be "${input.type}", not "${input.arch.type}".`,
    );
  }
  return Object.freeze({ ...input, kind: 'define', priority: input.priority ?? 16 });
}

/**
 * Changes a view of another module. Selectors are checked now; whether they match is checked
 * when the registry is built.
 * @throws {@link ViewError}
 * @public
 */
export function extendView(view: string, changes: readonly ViewChange[]): ViewExtension {
  if (!isViewId(view)) throw new ViewError(`Invalid view id "${view}".`);
  for (const change of changes) {
    parseSelector(change.at);
    const hasNodes = change.node !== undefined || change.nodes !== undefined;
    if (change.position === 'attributes') {
      if (!change.attributes || hasNodes) {
        throw new ViewError(
          `Extension of "${view}" at "${change.at}": "attributes" takes attributes only.`,
        );
      }
    } else if (change.attributes !== undefined || (change.position !== 'replace' && !hasNodes)) {
      throw new ViewError(
        `Extension of "${view}" at "${change.at}": "${change.position}" takes nodes.`,
      );
    }
  }
  return Object.freeze({ kind: 'extend', view, changes: Object.freeze([...changes]) });
}

// ─── applying selectors ────────────────────────────────────────────────────────────────────

type Path = readonly number[];

function stepMatches(step: SelectorStep, target: ViewNode): boolean {
  if (step.type !== '*' && step.type !== target.type) return false;
  return step.attributes.every(([name, value]) => {
    const actual = target.attrs[name];
    return (
      (typeof actual === 'string' || typeof actual === 'number' || typeof actual === 'boolean') &&
      String(actual) === value
    );
  });
}

/** Does `steps[0..k]` match `target`, given its ancestors (root first)? */
function chainMatches(
  steps: readonly SelectorStep[],
  k: number,
  target: ViewNode,
  ancestors: readonly ViewNode[],
): boolean {
  const step = steps[k] as SelectorStep;
  if (!stepMatches(step, target)) return false;
  if (k === 0) return true;
  if (step.combinator === 'child') {
    const parent = ancestors[ancestors.length - 1];
    return parent !== undefined && chainMatches(steps, k - 1, parent, ancestors.slice(0, -1));
  }
  for (let j = ancestors.length - 1; j >= 0; j--) {
    if (chainMatches(steps, k - 1, ancestors[j] as ViewNode, ancestors.slice(0, j))) return true;
  }
  return false;
}

/** Paths of every node matched by the selector. */
function select(root: ViewNode, selector: string): Path[] {
  const steps = parseSelector(selector);
  const found: Path[] = [];
  const walk = (current: ViewNode, path: Path, ancestors: readonly ViewNode[]): void => {
    if (chainMatches(steps, steps.length - 1, current, ancestors)) found.push(path);
    current.children.forEach((child, index) => {
      walk(child, [...path, index], [...ancestors, current]);
    });
  };
  walk(root, [], []);
  return found;
}

function withChildren(target: ViewNode, children: readonly ViewNode[]): ViewNode {
  return Object.freeze({ ...target, children: Object.freeze([...children]) });
}

/** Rebuilds the tree with the node at `path` (non-empty) replaced by `replacement`. */
function splice(
  root: ViewNode,
  path: Path,
  replacement: (target: ViewNode) => readonly ViewNode[],
): ViewNode {
  const [index = 0, ...rest] = path;
  const child = root.children[index] as ViewNode;
  const next = rest.length === 0 ? replacement(child) : [splice(child, rest, replacement)];
  return withChildren(root, [
    ...root.children.slice(0, index),
    ...next,
    ...root.children.slice(index + 1),
  ]);
}

/**
 * Applies the changes of an extension to an architecture.
 * @throws {@link ViewError} when a selector matches no node or several nodes
 * @public
 */
export function applyViewChanges(
  arch: ViewNode,
  changes: readonly ViewChange[],
  context: string,
): ViewNode {
  let current = arch;
  for (const change of changes) {
    const where = `${context}, at "${change.at}"`;
    const matches = select(current, change.at);
    if (matches.length === 0) throw new ViewError(`${where}: the selector matches no node.`);
    if (matches.length > 1) {
      throw new ViewError(
        `${where}: the selector matches ${String(matches.length)} nodes; make it more specific.`,
      );
    }
    const path = matches[0] as Path;
    const nodes = change.nodes ?? (change.node ? [change.node] : []);
    const isRoot = path.length === 0;

    switch (change.position) {
      case 'inside': {
        const update = (target: ViewNode) => [withChildren(target, [...target.children, ...nodes])];
        current = isRoot ? (update(current)[0] as ViewNode) : splice(current, path, update);
        break;
      }
      case 'attributes': {
        const update = (target: ViewNode): ViewNode[] => {
          const attrs = new Map<string, ViewAttribute>(Object.entries(target.attrs));
          for (const [key, value] of Object.entries(change.attributes ?? {})) {
            if (key === 'name')
              throw new ViewError(`${where}: the "name" of a node cannot change.`);
            if (value === null) attrs.delete(key);
            else attrs.set(key, value);
          }
          return [Object.freeze({ ...target, attrs: Object.freeze(Object.fromEntries(attrs)) })];
        };
        current = isRoot ? (update(current)[0] as ViewNode) : splice(current, path, update);
        break;
      }
      case 'before':
      case 'after':
      case 'replace': {
        if (isRoot)
          throw new ViewError(`${where}: "${change.position}" cannot target the root node.`);
        current = splice(current, path, (target) =>
          change.position === 'before'
            ? [...nodes, target]
            : change.position === 'after'
              ? [target, ...nodes]
              : nodes,
        );
        break;
      }
    }
  }
  return current;
}

// ─── registry ───────────────────────────────────────────────────────────────────────────────

/**
 * The views contributed by one module (`views/*.ts` files of the module).
 * @public
 */
export interface ModuleViews {
  readonly module: string;
  readonly views: readonly (ViewDefinition | ViewExtension)[];
}

/** @public */
export interface ComposedView {
  readonly id: string;
  readonly model: string;
  readonly type: ViewType;
  readonly priority: number;
  readonly arch: ViewNode;
  /** Modules that define or change the view, in application order. */
  readonly modules: readonly string[];
}

/** @public */
export interface ViewRegistry {
  /** @throws {@link ViewError} for an unknown view */
  get(id: string): ComposedView;
  /** The default view of a type for a model (lowest priority, then id), if any. */
  default(model: string, type: ViewType): ComposedView | undefined;
  ids(): readonly string[];
}

/** Checks node types, fields and buttons against the model registry. */
function validate(view: ComposedView, models: ModelRegistry): void {
  const fail = (message: string): never => {
    throw new ViewError(`View "${view.id}" (${view.modules.join(', ')}): ${message}`);
  };
  if (!models.has(view.model)) fail(`unknown model "${view.model}".`);
  const walk = (current: ViewNode, model: string): void => {
    if (!NODE_TYPES.has(current.type)) fail(`unknown node type "${current.type}".`);
    const meta = models.get(model);
    let childModel = model;
    const name = current.attrs.name;
    if (current.type === 'field') {
      const definition = typeof name === 'string' ? meta.fields.get(name) : undefined;
      if (!definition) fail(`unknown field "${describe(name)}" on "${model}".`);
      // Sub-views of a relational field describe its target model.
      if (definition?.comodel !== undefined) childModel = definition.comodel;
    }
    if (current.type === 'button') {
      const prototype = meta.recordClass.prototype as unknown as Record<string, unknown>;
      const known =
        typeof name === 'string' &&
        (typeof prototype[name] === 'function' || meta.serverMethodNames.includes(name));
      if (!known) fail(`button "${describe(name)}": no such method on "${model}".`);
    }
    for (const child of current.children) walk(child, childModel);
  };
  walk(view.arch, view.model);
}

/**
 * Composes the views of the installed modules, given in dependency order: definitions first,
 * then every extension in module order, then validation against the models.
 * @throws {@link ViewError}
 * @public
 */
export function buildViewRegistry(
  modules: readonly ModuleViews[],
  models: ModelRegistry,
): ViewRegistry {
  const views = new Map<string, ComposedView>();
  for (const { module, views: entries } of modules) {
    for (const entry of entries) {
      if (entry.kind === 'define') {
        if (!entry.id.startsWith(`${module}.`)) {
          throw new ViewError(`View "${entry.id}" must be prefixed by its module "${module}".`);
        }
        if (views.has(entry.id)) throw new ViewError(`View "${entry.id}" is defined twice.`);
        const { id, model, type, priority, arch } = entry;
        views.set(id, { id, model, type, priority, arch, modules: [module] });
      } else {
        const base = views.get(entry.view);
        if (!base) {
          throw new ViewError(
            `Module "${module}" extends "${entry.view}", which is not defined by a module it depends on.`,
          );
        }
        const arch = applyViewChanges(
          base.arch,
          entry.changes,
          `Extension of "${entry.view}" by "${module}"`,
        );
        views.set(entry.view, { ...base, arch, modules: [...base.modules, module] });
      }
    }
  }
  for (const view of views.values()) validate(view, models);
  const frozen = new Map([...views].map(([id, view]) => [id, Object.freeze(view)]));
  return {
    get(id) {
      const view = frozen.get(id);
      if (!view) throw new ViewError(`Unknown view "${id}".`);
      return view;
    },
    default(model, type) {
      return [...frozen.values()]
        .filter((view) => view.model === model && view.type === type)
        .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))[0];
    },
    ids: () => [...frozen.keys()].sort(),
  };
}

/**
 * The architecture a user may see: nodes restricted to groups they are not in are removed,
 * and so are fields restricted by the model (`groups` on the field definition). Only shapes
 * the interface; the server applies the same rules to the data it sends.
 * @public
 */
export function visibleArch(
  view: ComposedView,
  groups: ReadonlySet<string>,
  models: ModelRegistry,
): ViewNode {
  const allowed = (target: ViewNode): boolean => {
    const restricted = target.attrs.groups;
    return (
      !Array.isArray(restricted) ||
      restricted.some((group) => typeof group === 'string' && groups.has(group))
    );
  };
  const walk = (current: ViewNode, model: string): ViewNode => {
    const meta = models.get(model);
    const children: ViewNode[] = [];
    for (const child of current.children) {
      if (!allowed(child)) continue;
      let childModel = model;
      if (child.type === 'field') {
        const fieldName = child.attrs.name;
        const definition = typeof fieldName === 'string' ? meta.fields.get(fieldName) : undefined;
        if (!definition || !canSeeField(groups, definition)) continue;
        if (definition.comodel !== undefined) childModel = definition.comodel;
      }
      children.push(walk(child, childModel));
    }
    return withChildren(current, children);
  };
  return walk(view.arch, view.model);
}
