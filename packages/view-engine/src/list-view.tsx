// SPDX-License-Identifier: LGPL-3.0-only
//
// The `list` view of any model. It is a grid (ARIA) that draws only the rows on screen, whatever the
// number of records: the data source is asked for pages as the user scrolls, and rows that have not
// arrived yet are grey bars. Header cells sort, a checkbox column selects, the keyboard moves
// between rows, and the density (48 or 32 px per row) is the user's.
import type { ViewNode } from '@socle/framework';
import { Button, EmptyState, Skeleton } from '@socle/ui';
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { columnsOf, fieldsToRead, nextOrder, sortState, type Column } from './columns.js';
import { useMessages, useViewContext } from './context.js';
import { FieldValue } from './field-value.js';
import type { Draft } from './editing.js';
import type { FormEditState } from './form-view.js';
import { ListInput, useListEditing, type ListEditSession } from './list-editing.js';
import './list-view.css';
import { useLookups, type Lookups } from './lookups.js';
import type { Messages } from './messages.js';
import type { RecordValues } from './types.js';
import { windowOf } from './virtual.js';

const ROW_HEIGHT = { comfortable: 48, compact: 32 } as const;
const FALLBACK_VIEWPORT = 600;

export interface ListViewProps {
  /** The `list` node of the view (after the user's rights are applied). */
  readonly arch: ViewNode;
  readonly model: string;
  /** The accessible name of the list ("Contacts"). */
  readonly label: string;
  readonly domain?: readonly unknown[] | undefined;
  /** The order to start with (`name`, `city desc`). */
  readonly defaultOrder?: string | undefined;
  /** A record was chosen (click or Enter on its row). */
  readonly onOpen?: ((id: string) => void) | undefined;
  readonly onSelectionChange?: ((ids: ReadonlySet<string>) => void) | undefined;
  /** Buttons of the bar that appears when rows are selected. */
  readonly actions?: ((selected: ReadonlySet<string>) => React.ReactNode) | undefined;
  /** Records asked from the data source at once (default 100). */
  readonly pageSize?: number | undefined;
  /** Height of the visible area when it cannot be measured (tests). */
  readonly viewportHeight?: number | undefined;
  /** Enables scalar editing when the data source and field metadata permit it. */
  readonly editable?: boolean;
  /** Lets the host protect navigation and logout while a list draft is modified or saving. */
  readonly onEditStateChange?: ((state: FormEditState) => void) | undefined;
}

interface Loaded {
  readonly total: number | undefined;
  readonly pages: ReadonlyMap<number, readonly RecordValues[]>;
  readonly failed: boolean;
}

const EMPTY: Loaded = { total: undefined, pages: new Map(), failed: false };

interface RowProps {
  readonly record: RecordValues | undefined;
  readonly index: number;
  readonly columns: readonly Column[];
  readonly model: string;
  readonly rowHeight: number;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly lookups: Lookups;
  /** Changes when related names or currencies arrived. */
  readonly version: number;
  readonly messages: Messages;
  readonly onToggle: (id: string) => void;
  readonly edit: ListEditSession | undefined;
  readonly editing: boolean;
  readonly errorsId: string;
  readonly onChange: (name: string, value: Draft) => void;
}

const Row = memo(function Row({
  record,
  index,
  columns,
  rowHeight,
  selected,
  tabbable,
  lookups,
  messages,
  onToggle,
  model,
  edit,
  editing,
  errorsId,
  onChange,
}: RowProps): React.ReactElement {
  const view = useViewContext();
  const meta = view.registry.get(model);
  return (
    <div
      className="ve-row"
      role="row"
      aria-rowindex={index + 2}
      aria-selected={record === undefined ? undefined : selected}
      aria-busy={record === undefined ? 'true' : undefined}
      data-index={index}
      data-record={record?.id}
      data-editing={edit === undefined ? undefined : 'true'}
      tabIndex={tabbable ? 0 : -1}
      style={{ blockSize: `${String(rowHeight)}px` }}
    >
      <div className="ve-cell ve-select" role="gridcell">
        {record === undefined ? null : (
          <input
            type="checkbox"
            checked={selected}
            disabled={editing}
            aria-label={messages.selectRow}
            onChange={() => {
              onToggle(record.id);
            }}
          />
        )}
      </div>
      {columns.map((column) => (
        <div
          key={column.name}
          className="ve-cell"
          role="gridcell"
          data-type={column.definition.type}
        >
          {record === undefined ? (
            <span className="ve-bar" aria-hidden="true" />
          ) : edit && Object.hasOwn(edit.drafts, column.name) ? (
            <ListInput
              column={column}
              value={edit.drafts[column.name] ?? ''}
              errorId={errorsId}
              invalid={edit.errors[column.name] !== undefined}
              disabled={edit.saving}
              onChange={onChange}
            />
          ) : (
            <FieldValue
              definition={column.definition}
              value={record[column.name]}
              widget={column.widget}
              tones={column.tones}
              displayName={
                column.definition.comodel === undefined
                  ? undefined
                  : lookups.nameOf(column.definition.comodel, record[column.name])
              }
              currency={
                column.definition.type === 'monetary'
                  ? lookups.currencyOf(
                      record[meta.fields.get(column.name)?.currencyField ?? 'currencyId'],
                    )
                  : undefined
              }
              record={record}
            />
          )}
        </div>
      ))}
    </div>
  );
});

export function ListView({
  arch,
  model,
  label,
  domain,
  defaultOrder,
  onOpen,
  onSelectionChange,
  actions,
  pageSize = 100,
  viewportHeight: forcedViewport,
  editable = false,
  onEditStateChange,
}: ListViewProps): React.ReactElement {
  const view = useViewContext();
  const messages = useMessages();
  const meta = view.registry.get(model);
  const columns = useMemo(() => columnsOf(arch, meta, view.language), [arch, meta, view.language]);
  const fields = useMemo(() => fieldsToRead(columns), [columns]);
  const rowHeight = ROW_HEIGHT[view.density];
  const lookups = useLookups(view);
  const { ensure } = lookups;

  const [order, setOrder] = useState(defaultOrder);
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState(0);
  const [focused, setFocused] = useState<number | undefined>(undefined);
  const focusRequestRef = useRef<number | undefined>(undefined);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const inflightRef = useRef(new Set<number>());
  const domainKey = JSON.stringify(domain ?? []);
  const errorsId = useId();
  const editScope = useMemo(
    () => ({ model, data: view.data, registry: view.registry, arch, domainKey }),
    [model, view.data, view.registry, arch, domainKey],
  );
  const editor = useListEditing({
    enabled: editable && arch.attrs.readonly !== true,
    model,
    columns,
    lookups,
    scope: editScope,
    onEditStateChange,
    onSaved: () => {
      setRetry((count) => count + 1);
    },
  });
  const edit = editor.session;
  const previousEditRef = useRef<string | undefined>(undefined);
  const previousErrorsRef = useRef<Readonly<Record<string, string>>>({});
  useEffect(() => {
    const previous = previousEditRef.current;
    if (edit && previous !== edit.original.id) {
      scrollerRef.current?.querySelector<HTMLElement>('[data-inline-input]')?.focus();
    } else if (!edit && previous !== undefined) {
      const row = [
        ...(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-record]') ?? []),
      ].find((candidate) => candidate.dataset.record === previous);
      row?.focus({ preventScroll: true });
    }
    previousEditRef.current = edit?.original.id;
  }, [edit]);
  useEffect(() => {
    const previous = previousErrorsRef.current;
    previousErrorsRef.current = edit?.errors ?? {};
    if (
      !edit ||
      edit.saving ||
      !Object.entries(edit.errors).some(([name, value]) => previous[name] !== value)
    )
      return;
    const input = [
      ...(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-inline-input]') ?? []),
    ].find((candidate) => edit.errors[candidate.dataset.inlineInput ?? ''] !== undefined);
    input?.focus();
  }, [edit]);

  // Start again whenever what is asked for changes (model, search, order, columns, retry): the state
  // is reset while rendering, before anything is drawn from the old query.
  const query = { model, domainKey, order, fields, pageSize, data: view.data, retry };
  const [seen, setSeen] = useState(query);
  if (
    !Object.entries(query).every(([key, value]) => Object.is(seen[key as keyof typeof seen], value))
  ) {
    setSeen(query);
    setLoaded(EMPTY);
    setSelection(new Set());
    setFocused(undefined);
    setScrollTop(0);
  }
  useEffect(() => {
    generationRef.current += 1;
    inflightRef.current.clear();
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [model, domainKey, order, fields, pageSize, view.data, retry]);

  // The visible area: measured, or given for tests.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return undefined;
    const measure = (): void => {
      setMeasured(element.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const viewport = forcedViewport ?? (measured > 0 ? measured : FALLBACK_VIEWPORT);

  const window = windowOf({
    scrollTop,
    viewportHeight: viewport,
    rowHeight,
    total: loaded.total ?? 0,
  });

  // Ask for the pages the window needs and does not have.
  useEffect(() => {
    // A failed read waits for the explicit retry; an accepted write must never be replayed.
    if (loaded.failed) return;
    const needed: number[] = [];
    if (loaded.total === undefined) needed.push(0);
    else {
      for (
        let page = Math.floor(window.start / pageSize);
        page * pageSize < window.end;
        page += 1
      ) {
        needed.push(page);
      }
    }
    for (const page of needed) {
      if (loaded.pages.has(page) || inflightRef.current.has(page)) continue;
      inflightRef.current.add(page);
      const mine = generationRef.current;
      view.data
        .search(model, { fields, domain, order, limit: pageSize, offset: page * pageSize })
        .then(async (result) => {
          if (mine !== generationRef.current) return;
          setLoaded((previous) => ({
            total: result.total,
            pages: new Map(previous.pages).set(page, result.records),
            failed: false,
          }));
          await ensure(model, result.records, fields);
        })
        .catch(() => {
          if (mine === generationRef.current)
            setLoaded((previous) => ({ ...previous, failed: true }));
        })
        .finally(() => {
          inflightRef.current.delete(page);
        });
    }
    // `window` is derived from scroll, size and total: listed through its parts.
  }, [loaded, window.start, window.end, pageSize, model, domain, order, fields, view.data, ensure]);

  const recordAt = (index: number): RecordValues | undefined =>
    loaded.pages.get(Math.floor(index / pageSize))?.[index % pageSize];

  const loadedIds = useMemo(
    () => [...loaded.pages.values()].flatMap((records) => records.map((record) => record.id)),
    [loaded.pages],
  );

  const updateSelection = useCallback(
    (next: ReadonlySet<string>) => {
      setSelection(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      updateSelection(next);
    },
    [selection, updateSelection],
  );

  const total = loaded.total ?? 0;
  const selectedRecord =
    selection.size === 1
      ? [...loaded.pages.values()].flat().find((record) => selection.has(record.id))
      : undefined;
  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));
  const someSelected = selection.size > 0 && !allSelected;

  // Keep the focus on a row that exists and scroll so that it is seen.
  const moveFocus = (index: number): void => {
    if (total === 0) return;
    const target = Math.min(total - 1, Math.max(0, index));
    setFocused(target);
    focusRequestRef.current = target;
    const element = scrollerRef.current;
    if (!element) return;
    const body = viewport - rowHeight; // the sticky header covers one row
    const top = target * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + body) element.scrollTop = top + rowHeight - body;
    setScrollTop(element.scrollTop);
  };

  // Once the row asked for is drawn (it may need a scroll first), it takes the focus.
  useEffect(() => {
    const target = focusRequestRef.current;
    if (target === undefined) return;
    const row = scrollerRef.current?.querySelector<HTMLElement>(`[data-index="${String(target)}"]`);
    if (row) {
      row.focus({ preventScroll: true });
      focusRequestRef.current = undefined;
    }
  });
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      edit &&
      (event.key === 'Escape' ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') ||
        (event.key === 'Enter' && (event.target as HTMLElement).hasAttribute('data-inline-input')))
    ) {
      event.preventDefault();
      if (event.key === 'Escape') editor.cancel();
      else void editor.save();
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!row || event.target !== row) return;
    const index = Number(row.dataset.index);
    const page = Math.max(1, Math.floor((viewport - rowHeight) / rowHeight));
    const handled: Record<string, () => void> = {
      ArrowDown: () => {
        moveFocus(index + 1);
      },
      ArrowUp: () => {
        moveFocus(index - 1);
      },
      PageDown: () => {
        moveFocus(index + page);
      },
      PageUp: () => {
        moveFocus(index - page);
      },
      Home: () => {
        moveFocus(0);
      },
      End: () => {
        moveFocus(total - 1);
      },
      Enter: () => {
        const id = row.dataset.record;
        if (id !== undefined && !edit) onOpen?.(id);
      },
      F2: () => {
        const record = recordAt(index);
        if (record && !edit) {
          updateSelection(new Set([record.id]));
          editor.begin(record);
        }
      },
      ' ': () => {
        const id = row.dataset.record;
        if (id !== undefined && !edit) toggle(id);
      },
    };
    const action = Object.hasOwn(handled, event.key) ? handled[event.key] : undefined;
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (edit || target.closest('a, button, input, select, label')) return;
    const row = target.closest<HTMLElement>('[data-record]');
    if (row?.dataset.record !== undefined) {
      setFocused(Number(row.dataset.index));
      onOpen?.(row.dataset.record);
    }
  };

  // The one row that can be reached with Tab: the focused one, or the first drawn.
  const tabbable = Math.min(
    Math.max(focused ?? 0, window.start),
    Math.max(window.start, window.end - 1),
  );

  const rows = [];
  for (let index = window.start; index < window.end; index += 1) {
    const record = recordAt(index);
    rows.push(
      <Row
        key={index}
        record={record}
        index={index}
        columns={columns}
        model={model}
        rowHeight={rowHeight}
        selected={record !== undefined && selection.has(record.id)}
        tabbable={index === tabbable}
        lookups={lookups}
        version={lookups.version}
        messages={messages}
        onToggle={toggle}
        edit={record?.id === edit?.original.id ? edit : undefined}
        editing={edit !== undefined}
        errorsId={errorsId}
        onChange={editor.change}
      />,
    );
  }

  const first = loaded.total === undefined && !loaded.failed;
  // The first column (the name) gets more room than the others.
  const template = `2.75rem minmax(12rem, 1.6fr) repeat(${String(Math.max(columns.length - 1, 0))}, minmax(8rem, 1fr))`;

  return (
    <div className="ve-list" data-density={view.density} onKeyDown={onKeyDown}>
      <div className="ve-list-bar">
        <p className="ve-list-count" role="status">
          {loaded.total === undefined ? '' : messages.rowsCount(loaded.total)}
        </p>
        {edit ? (
          <div className="ve-list-edit-actions" role="group" aria-label={messages.editingRow}>
            <span>{messages.editingRow}</span>
            <Button
              size="sm"
              variant="primary"
              loading={edit.saving}
              disabled={edit.saving}
              onClick={() => {
                void editor.save();
              }}
            >
              {edit.saving ? messages.saving : messages.save}
            </Button>
            <Button size="sm" disabled={edit.saving} onClick={editor.cancel}>
              {messages.cancel}
            </Button>
          </div>
        ) : selection.size > 0 ? (
          <div
            className="ve-list-actions"
            role="group"
            aria-label={messages.selected(selection.size)}
          >
            <span>{messages.selected(selection.size)}</span>
            {selectedRecord && editor.canEdit(selectedRecord) ? (
              <Button
                size="sm"
                onClick={() => {
                  editor.begin(selectedRecord);
                }}
              >
                {messages.editRow}
              </Button>
            ) : null}
            {actions?.(selection)}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                updateSelection(new Set());
              }}
            >
              {messages.clearSelection}
            </Button>
          </div>
        ) : null}
      </div>
      {editor.notice ? (
        <p className="ve-list-count" role="status">
          {messages.saved}
        </p>
      ) : null}
      {edit && (edit.failure || Object.keys(edit.errors).length > 0) ? (
        <div className="ve-list-message" role="alert" id={errorsId}>
          {edit.failure ? <p>{edit.failure}</p> : null}
          {Object.entries(edit.errors).map(([name, error]) => (
            <p key={name}>
              {columns.find((column) => column.name === name)?.label ?? name} : {error}
            </p>
          ))}
        </div>
      ) : null}

      {loaded.failed ? (
        <div className="ve-list-message" role="alert">
          <p>{messages.loadError}</p>
          <Button
            size="sm"
            onClick={() => {
              setRetry((count) => count + 1);
            }}
          >
            {messages.retry}
          </Button>
        </div>
      ) : null}

      {loaded.total === 0 ? (
        <EmptyState icon={Inbox} title={messages.emptyTitle}>
          {messages.empty}
        </EmptyState>
      ) : null}

      {first ? <Skeleton lines={6} label={messages.loading} /> : null}

      <div
        className="ve-grid"
        role="grid"
        aria-label={label}
        aria-rowcount={total + 1}
        aria-colcount={columns.length + 1}
        aria-multiselectable="true"
        hidden={loaded.total === undefined || loaded.total === 0}
      >
        <div
          ref={scrollerRef}
          className="ve-scroll"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
          }}
          onClick={onClick}
          style={
            {
              '--ve-columns': template,
              '--ve-row': `${String(rowHeight)}px`,
            } as React.CSSProperties
          }
        >
          <div className="ve-row ve-head" role="row" aria-rowindex={1}>
            <div className="ve-cell ve-select" role="columnheader">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={edit !== undefined}
                ref={(box) => {
                  if (box) box.indeterminate = someSelected;
                }}
                aria-label={messages.selectAll}
                onChange={() => {
                  updateSelection(allSelected ? new Set() : new Set(loadedIds));
                }}
              />
            </div>
            {columns.map((column) => (
              <div
                key={column.name}
                className="ve-cell"
                role="columnheader"
                aria-sort={column.sortable ? sortState(order, column.name) : undefined}
              >
                {column.sortable ? (
                  <button
                    type="button"
                    className="ve-sort"
                    disabled={edit !== undefined}
                    aria-label={messages.sortBy(column.label)}
                    onClick={() => {
                      setOrder(nextOrder(order, column.name));
                    }}
                  >
                    <span>{column.label}</span>
                    {sortState(order, column.name) === 'ascending' ? (
                      <ArrowUp size={14} strokeWidth={1.5} aria-hidden="true" />
                    ) : sortState(order, column.name) === 'descending' ? (
                      <ArrowDown size={14} strokeWidth={1.5} aria-hidden="true" />
                    ) : (
                      <ArrowUpDown size={14} strokeWidth={1.5} aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <span>{column.label}</span>
                )}
              </div>
            ))}
          </div>
          <div
            className="ve-body"
            role="rowgroup"
            style={{ blockSize: `${String(window.height)}px` }}
          >
            <div
              className="ve-window"
              style={{ transform: `translateY(${String(window.offset)}px)` }}
            >
              {rows}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
