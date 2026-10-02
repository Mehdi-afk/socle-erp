// SPDX-License-Identifier: LGPL-3.0-only
import type { ViewSnapshot } from '@socle/framework';
import { humanize, resolveText } from '@socle/view-engine';
import { z } from 'zod';

import type { WebClient } from './rpc-data-source.js';

/** A readable model with an available list and, optionally, a record form. */
export interface ViewEntry {
  readonly model: string;
  readonly label: string;
  readonly list: ViewSnapshot;
  readonly form?: ViewSnapshot;
}

/** A location in the authenticated client's in-memory navigation stack. */
export interface WebRoute {
  readonly model: string;
  readonly id?: string;
}

/** Visible navigation entries, ordered by their translated labels and then model names. */
export function catalogEntries(
  client: Pick<WebClient, 'registry' | 'views'>,
  language: string,
): readonly ViewEntry[] {
  const collator = new Intl.Collator(language);
  const entries: ViewEntry[] = [];
  for (const model of client.registry.names()) {
    const meta = client.registry.get(model);
    if (meta.abstract) continue;
    const list = client.views.default(model, 'list');
    if (list === undefined) continue;
    const form = client.views.default(model, 'form');
    entries.push({
      model,
      label: resolveText(meta.description, language, humanize(model)),
      list,
      ...(form === undefined ? {} : { form }),
    });
  }
  return entries.sort(
    (left, right) =>
      collator.compare(left.label, right.label) ||
      (left.model < right.model ? -1 : left.model > right.model ? 1 : 0),
  );
}

const recordId = z.uuid();

/** Resolves only a known list, or a known form with a valid record identifier. */
export function routeView(
  entries: readonly ViewEntry[],
  route: WebRoute,
): ViewSnapshot | undefined {
  const entry = entries.find((candidate) => candidate.model === route.model);
  if (entry === undefined) return undefined;
  if (route.id === undefined) return entry.list;
  return recordId.safeParse(route.id).success ? entry.form : undefined;
}

/** Appends a destination unless it is already the current location. */
export function navigate(stack: readonly WebRoute[], route: WebRoute): readonly WebRoute[] {
  const current = stack.at(-1);
  return current?.model === route.model && current.id === route.id ? stack : [...stack, route];
}

/** Returns to a breadcrumb, leaving an invalid index or the current location unchanged. */
export function backTo(stack: readonly WebRoute[], index: number): readonly WebRoute[] {
  return Number.isInteger(index) && index >= 0 && index < stack.length - 1
    ? stack.slice(0, index + 1)
    : stack;
}
