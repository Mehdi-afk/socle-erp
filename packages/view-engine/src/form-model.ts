// SPDX-License-Identifier: LGPL-3.0-only
//
// What a `form` view shows, read from its architecture and checked against the model: a header, cards
// of fields, notebook pages, embedded lists, and the automatic card of confidential data. Pure, so
// that it is tested without any rendering.
import type { FieldMetadata, LocalizedText, ModelMetadata, ViewNode } from '@socle/framework';

import { labelOf } from './columns.js';
import { humanize, resolveText } from './text.js';

export interface FormField {
  readonly name: string;
  readonly definition: FieldMetadata;
  readonly label: string;
  readonly widget: string | undefined;
  readonly tones: Readonly<Record<string, unknown>> | undefined;
  readonly sensitive: boolean;
  /** A view may further restrict editing, never relax a read-only model field. */
  readonly readonly?: boolean;
}

export interface FormAction {
  /** The method of the model the button calls. */
  readonly method: string;
  readonly label: string;
  readonly primary: boolean;
}

export interface FormHeader {
  readonly title: FormField | undefined;
  readonly subtitle: FormField | undefined;
  readonly avatar: FormField | undefined;
  readonly actions: readonly FormAction[];
}

/** An embedded list: the records of a one2many field. */
export interface FormRelation {
  readonly field: FormField;
  readonly comodel: string;
  /** The many2one of the comodel that points back to this record. */
  readonly inverse: string;
  /** The `list` view drawn inside (the one the view declares, else the comodel's name). */
  readonly arch: ViewNode;
}

export type FormBlock =
  | {
      readonly kind: 'card';
      readonly title: string | undefined;
      readonly fields: readonly FormField[];
    }
  | { readonly kind: 'relation'; readonly title: string; readonly relation: FormRelation }
  | { readonly kind: 'tabs'; readonly pages: readonly FormPage[] }
  | { readonly kind: 'columns'; readonly blocks: readonly FormBlock[] }
  | { readonly kind: 'chatter' };

export interface FormPage {
  readonly id: string;
  readonly label: string;
  readonly blocks: readonly FormBlock[];
}

export interface FormLayout {
  readonly header: FormHeader;
  readonly blocks: readonly FormBlock[];
  /** Sensitive fields, gathered from wherever the view put them. */
  readonly confidential: readonly FormField[];
  /** Every field to read (the ones shown, the header's, the currencies of amounts). */
  readonly fields: readonly string[];
}

const isLocalized = (value: unknown): value is LocalizedText =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { fr?: unknown }).fr === 'string';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function fieldOf(node: ViewNode, meta: ModelMetadata, language: string): FormField | undefined {
  const name = str(node.attrs.name);
  const definition = name === undefined ? undefined : meta.fields.get(name);
  if (name === undefined || !definition) return undefined;
  const { tones } = node.attrs;
  return {
    name,
    definition,
    label: labelOf(name, definition, language, node.attrs.label),
    widget: str(node.attrs.widget),
    tones:
      typeof tones === 'object' && tones !== null && !Array.isArray(tones)
        ? (tones as Readonly<Record<string, unknown>>)
        : undefined,
    sensitive: definition.sensitive === true,
    readonly: node.attrs.readonly === true,
  };
}

/** The layout of a form view for a model, in the user's language. */
export function layoutOf(arch: ViewNode, meta: ModelMetadata, language: string): FormLayout {
  const confidential: FormField[] = [];
  const read = new Set<string>();
  let hasChatter = false;

  const remember = (field: FormField): void => {
    read.add(field.name);
    if (field.definition.type === 'monetary') {
      read.add(field.definition.currencyField ?? 'currencyId');
    }
  };

  const relationOf = (node: ViewNode, field: FormField): FormRelation | undefined => {
    const { comodel, inverse } = field.definition;
    if (field.definition.type !== 'one2many' || comodel === undefined || inverse === undefined) {
      return undefined;
    }
    const declared = node.children.find((child) => child.type === 'list');
    return {
      field,
      comodel,
      inverse,
      arch: declared ?? {
        type: 'list',
        attrs: {},
        children: [{ type: 'field', attrs: { name: 'name' }, children: [] }],
      },
    };
  };

  /** Consecutive plain fields make one card; containers and relations break the run. */
  const blocksOf = (nodes: readonly ViewNode[], title: string | undefined): FormBlock[] => {
    const blocks: FormBlock[] = [];
    let run: FormField[] = [];
    let runTitle = title;
    const flush = (): void => {
      if (run.length > 0) blocks.push({ kind: 'card', title: runTitle, fields: run });
      run = [];
      runTitle = undefined;
    };
    for (const child of nodes) {
      if (child.type === 'field') {
        const field = fieldOf(child, meta, language);
        if (!field) continue;
        if (field.sensitive) {
          confidential.push(field);
          continue;
        }
        const relation = relationOf(child, field);
        if (relation) {
          // Its records come from the embedded list, not from this record.
          flush();
          blocks.push({ kind: 'relation', title: field.label, relation });
        } else {
          remember(field);
          run.push(field);
        }
      } else if (child.type === 'chatter') {
        flush();
        if (!hasChatter) blocks.push({ kind: 'chatter' });
        hasChatter = true;
      } else if (child.type === 'group') {
        flush();
        const label = isLocalized(child.attrs.label)
          ? resolveText(child.attrs.label, language)
          : undefined;
        const inner = blocksOf(child.children, label);
        // A group that only holds fields is one card; one that holds containers is columns.
        const single = inner.length === 1 ? inner[0] : undefined;
        if (single) blocks.push(single);
        else if (inner.length > 1) blocks.push({ kind: 'columns', blocks: inner });
      } else if (child.type === 'sheet') {
        flush();
        blocks.push(...blocksOf(child.children, undefined));
      } else if (child.type === 'notebook') {
        flush();
        const pages = child.children
          .filter((page) => page.type === 'page')
          .map((page, index): FormPage => {
            const label = isLocalized(page.attrs.label)
              ? resolveText(page.attrs.label, language)
              : '';
            const id = str(page.attrs.name) ?? `page-${String(index)}`;
            return {
              id,
              label: label === '' ? humanize(id) : label,
              blocks: blocksOf(page.children, undefined),
            };
          })
          .filter((page) => page.blocks.length > 0);
        if (pages.length > 0) blocks.push({ kind: 'tabs', pages });
      }
    }
    flush();
    return blocks;
  };

  // The header: which fields make the title, and the buttons.
  const headerNode = arch.children.find((child) => child.type === 'header');
  const named = (attribute: string): FormField | undefined => {
    const name = headerNode ? str(headerNode.attrs[attribute]) : undefined;
    const definition = name === undefined ? undefined : meta.fields.get(name);
    if (name === undefined || !definition) return undefined;
    const field: FormField = {
      name,
      definition,
      label: labelOf(name, definition, language),
      widget: undefined,
      tones: undefined,
      sensitive: false,
    };
    remember(field);
    return field;
  };
  const header: FormHeader = {
    title: named('title'),
    subtitle: named('subtitle'),
    avatar: named('avatar'),
    actions: (headerNode?.children ?? [])
      .filter((child) => child.type === 'button' && str(child.attrs.name) !== undefined)
      .map((child) => ({
        method: child.attrs.name as string,
        label: isLocalized(child.attrs.label)
          ? resolveText(child.attrs.label, language)
          : humanize(child.attrs.name as string),
        primary: child.attrs.primary === true,
      })),
  };

  const blocks = blocksOf(
    arch.children.filter((child) => child.type !== 'header'),
    undefined,
  );
  for (const field of confidential) remember(field);
  return { header, blocks, confidential, fields: [...read] };
}
