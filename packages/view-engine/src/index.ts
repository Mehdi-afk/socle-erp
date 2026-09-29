// SPDX-License-Identifier: LGPL-3.0-only
//
// The view engine: turns the architecture of a view (a tree of nodes declared by the modules) into
// screens, for any model, with the design system of `@socle/ui`. Nothing here is specific to a
// model: contacts, invoices and tickets are drawn by the same code.
export { columnsOf, fieldsToRead, labelOf, nextOrder, sortState } from './columns.js';
export type { Column } from './columns.js';
export { ViewEngineProvider, useMessages, useViewContext } from './context.js';
export type { ViewEngineProviderProps } from './context.js';
export { FieldValue } from './field-value.js';
export type { FieldValueProps, Widget } from './field-value.js';
export { formatValue, minorToDecimal } from './format.js';
export type { Currency, FormatContext, FormatExtras } from './format.js';
export { emailHref, phoneHref, webHref } from './links.js';
export { ListView } from './list-view.js';
export type { ListViewProps } from './list-view.js';
export { createMemoryDataSource } from './memory-data-source.js';
export type { MemoryDataSource } from './memory-data-source.js';
export { messagesFor } from './messages.js';
export type { Messages } from './messages.js';
export { humanize, resolveText } from './text.js';
export type {
  DataSource,
  Density,
  RecordValues,
  SearchOptions,
  SearchResult,
  ViewContext,
} from './types.js';
export { windowOf } from './virtual.js';
export type { RowWindow, WindowInput } from './virtual.js';
