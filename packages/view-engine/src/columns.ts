// SPDX-License-Identifier: LGPL-3.0-only
//
// What a `list` view asks for: its columns, read from the architecture and checked against the
// model. Pure, so that it is tested without any rendering.
import {
  isStoredColumn,
  type FieldDefinition,
  type LocalizedText,
  type ModelMeta,
  type ViewNode,
} from '@socle/framework';

import { humanize, resolveText } from './text.js';

export interface Column {
  readonly name: string;
  readonly definition: FieldDefinition;
  /** The header text, in the user's language. */
  readonly label: string;
  /** How the view asks the value to be shown (`phone`, `email`, `status_badge`, `avatar`…). */
  readonly widget: string | undefined;
  /** For `status_badge`: the tone of each value. */
  readonly tones: Readonly<Record<string, unknown>> | undefined;
  /** The database can sort on it (a stored column). */
  readonly sortable: boolean;
}

const isLocalized = (value: unknown): value is LocalizedText =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { fr?: unknown }).fr === 'string';

/** The label of a field: the view's, else the model's, else made from its name. */
export function labelOf(
  name: string,
  definition: FieldDefinition,
  language: string,
  override?: unknown,
): string {
  const fromView = isLocalized(override) ? resolveText(override, language) : '';
  if (fromView !== '') return fromView;
  return resolveText(definition.label, language, humanize(name));
}

/**
 * The columns of a list view, in order. Nodes that are not fields, and fields the model does not
 * have, are ignored (the view registry already refuses the latter; this keeps the engine safe with
 * a view it did not validate).
 */
export function columnsOf(arch: ViewNode, meta: ModelMeta, language: string): Column[] {
  const columns: Column[] = [];
  for (const child of arch.children) {
    if (child.type !== 'field') continue;
    const name = child.attrs.name;
    if (typeof name !== 'string') continue;
    const definition = meta.fields.get(name);
    if (!definition) continue;
    const { widget, tones } = child.attrs;
    columns.push({
      name,
      definition,
      label: labelOf(name, definition, language, child.attrs.label),
      widget: typeof widget === 'string' ? widget : undefined,
      tones:
        typeof tones === 'object' && tones !== null && !Array.isArray(tones)
          ? (tones as Readonly<Record<string, unknown>>)
          : undefined,
      sortable: isStoredColumn(definition),
    });
  }
  return columns;
}

/** The names of the fields to read for these columns, and the currency fields their values need. */
export function fieldsToRead(columns: readonly Column[]): string[] {
  const names = new Set<string>();
  for (const column of columns) {
    names.add(column.name);
    if (column.definition.type === 'monetary') {
      names.add(column.definition.currencyField ?? 'currencyId');
    }
  }
  return [...names];
}

/** The next sort order when a header is activated: ascending, descending, then none. */
export function nextOrder(current: string | undefined, name: string): string | undefined {
  if (current === name) return `${name} desc`;
  if (current === `${name} desc`) return undefined;
  return name;
}

/** `aria-sort` of a column for the current order. */
export function sortState(
  current: string | undefined,
  name: string,
): 'ascending' | 'descending' | 'none' {
  if (current === name) return 'ascending';
  if (current === `${name} desc`) return 'descending';
  return 'none';
}
