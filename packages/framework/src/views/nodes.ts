// SPDX-License-Identifier: LGPL-3.0-only
//
// View architecture: an immutable tree of typed nodes built with small helpers
// (`form([...])`, `field('partnerId')`…), ARCHITECTURE.md §4.5.
import type { LocalizedText } from '../registry/manifest.js';

/**
 * A node attribute: JSON-compatible values only (views travel to the web client).
 * @public
 */
export type ViewAttribute =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | LocalizedText
  | { readonly [key: string]: ViewAttribute }
  | readonly ViewAttribute[];

/** @public */
export type ViewAttributes = Readonly<Record<string, ViewAttribute>>;

/**
 * A node of a view architecture.
 * @public
 */
export interface ViewNode {
  readonly type: string;
  readonly attrs: ViewAttributes;
  readonly children: readonly ViewNode[];
}

/**
 * Attributes every node accepts.
 * @public
 */
export interface CommonNodeAttributes {
  /** Name used by selectors (`group[name='totals']`). */
  readonly name?: string;
  /** Only members of one of these groups see the node. */
  readonly groups?: readonly string[];
  readonly label?: LocalizedText;
  readonly [key: string]: ViewAttribute | undefined;
}

/**
 * Builds a node (attributes without `undefined` values, frozen).
 * @public
 */
export function node(
  type: string,
  attrs: CommonNodeAttributes = {},
  children: readonly ViewNode[] = [],
): ViewNode {
  const clean: Record<string, ViewAttribute> = {};
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) clean[key] = value;
  return Object.freeze({
    type,
    attrs: Object.freeze(clean),
    children: Object.freeze([...children]),
  });
}

/**
 * A container node builder: `group([...])` or `group({ name: 'totals' }, [...])`.
 * @public
 */
export type ContainerBuilder = {
  (children: readonly ViewNode[]): ViewNode;
  (attrs: CommonNodeAttributes, children: readonly ViewNode[]): ViewNode;
};

const container =
  (type: string): ContainerBuilder =>
  (first: CommonNodeAttributes | readonly ViewNode[], second?: readonly ViewNode[]): ViewNode =>
    Array.isArray(first)
      ? node(type, {}, first as readonly ViewNode[])
      : node(type, first as CommonNodeAttributes, second ?? []);

/** @public */
export const form: ContainerBuilder = container('form');
/** @public */
export const list: ContainerBuilder = container('list');
/** @public */
export const kanban: ContainerBuilder = container('kanban');
/** @public */
export const search: ContainerBuilder = container('search');
/** @public */
export const header: ContainerBuilder = container('header');
/** @public */
export const sheet: ContainerBuilder = container('sheet');
/** @public */
export const group: ContainerBuilder = container('group');
/** @public */
export const notebook: ContainerBuilder = container('notebook');

/**
 * A notebook page.
 * @public
 */
export function page(
  name: string,
  label: LocalizedText | string,
  children: readonly ViewNode[],
): ViewNode {
  return node('page', { name, label: typeof label === 'string' ? { fr: label } : label }, children);
}

/**
 * A field of the view's model.
 * @public
 */
export function field(name: string, attrs: CommonNodeAttributes = {}): ViewNode {
  return node('field', { ...attrs, name });
}

/**
 * A button calling a method of the model (`states`: only shown in these states).
 * @public
 */
export function button(
  method: string,
  attrs: CommonNodeAttributes & {
    readonly states?: readonly string[];
    readonly primary?: boolean;
  } = {},
): ViewNode {
  return node('button', { ...attrs, name: method });
}

/**
 * A search filter: a named domain the user can toggle.
 * @public
 */
export function filter(name: string, attrs: CommonNodeAttributes = {}): ViewNode {
  return node('filter', { ...attrs, name });
}
