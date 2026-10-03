// SPDX-License-Identifier: LGPL-3.0-only
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import type { Column } from './columns.js';
import { useMessages, useViewContext } from './context.js';
import { changesOf, isEditable, toDraft, type Draft, type EditProblem } from './editing.js';
import type { FormEditState } from './form-view.js';
import type { FormField } from './form-model.js';
import type { Lookups } from './lookups.js';
import type { Messages } from './messages.js';
import { WriteFailure, type RecordValues } from './types.js';

export interface ListEditSession {
  readonly original: RecordValues;
  readonly initial: Readonly<Record<string, Draft>>;
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly failure: string | undefined;
  readonly saving: boolean;
}

function problemText(problem: EditProblem, label: string, messages: Messages): string {
  if (problem.code === 'required') return messages.problem.required(label);
  if (problem.code === 'decimals') return messages.problem.decimals(problem.max);
  return messages.problem[problem.code];
}

/** Scalar inputs keep the fixed-height virtual rows; relations and prose use the form. */
export function inlineFields(columns: readonly Column[]): FormField[] {
  return columns
    .filter((column) => !['text', 'many2one'].includes(column.definition.type))
    .map((column) => ({ ...column, sensitive: column.definition.sensitive === true }));
}

export function useListEditing({
  enabled,
  model,
  columns,
  lookups,
  scope,
  onSaved,
  onEditStateChange,
}: {
  readonly enabled: boolean;
  readonly model: string;
  readonly columns: readonly Column[];
  readonly lookups: Lookups;
  readonly scope: object;
  readonly onSaved: () => void;
  readonly onEditStateChange: ((state: FormEditState) => void) | undefined;
}) {
  const view = useViewContext();
  const messages = useMessages();
  const [session, setSession] = useState<ListEditSession>();
  const [notice, setNotice] = useState(false);
  const [seen, setSeen] = useState(scope);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  if (seen !== scope) {
    setSeen(scope);
    setSession(undefined);
    setNotice(false);
  }
  const current = seen === scope ? session : undefined;
  const fields = inlineFields(columns);
  const currencyOf = (field: FormField, record: RecordValues) =>
    lookups.currencyOf(record[field.definition.currencyField ?? 'currencyId']);
  const dirty =
    current !== undefined &&
    Object.entries(current.drafts).some(([name, value]) => value !== current.initial[name]);
  const saving = current?.saving === true;
  const report = useEffectEvent((state: FormEditState) => onEditStateChange?.(state));
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      report({ dirty: false, saving: false });
    };
  }, []);
  useEffect(() => {
    report({ dirty, saving });
  }, [dirty, saving]);

  const canEdit = (record: RecordValues): boolean =>
    enabled &&
    view.data.write !== undefined &&
    fields.some((field) => isEditable(field, currencyOf(field, record)));
  function begin(record: RecordValues): void {
    if (!canEdit(record) || current || inFlightRef.current) return;
    const drafts = Object.fromEntries(
      fields
        .filter((field) => isEditable(field, currencyOf(field, record)))
        .map((field) => [
          field.name,
          toDraft(field.definition, record[field.name], currencyOf(field, record)),
        ]),
    );
    if (Object.keys(drafts).length === 0) return;
    setNotice(false);
    setSession({
      original: record,
      initial: drafts,
      drafts,
      errors: {},
      failure: undefined,
      saving: false,
    });
  }
  const change = useCallback((name: string, value: Draft) => {
    setSession((previous) =>
      previous === undefined || previous.saving
        ? previous
        : {
            ...previous,
            drafts: { ...previous.drafts, [name]: value },
            errors: Object.fromEntries(
              Object.entries(previous.errors).filter(([key]) => key !== name),
            ),
            failure: undefined,
          },
    );
  }, []);
  function cancel(): void {
    if (!inFlightRef.current) setSession(undefined);
  }
  async function save(): Promise<void> {
    if (!current || inFlightRef.current || !view.data.write) return;
    inFlightRef.current = true;
    const mine = scope;
    const fresh = (): boolean => mountedRef.current && scopeRef.current === mine;
    setSession({ ...current, errors: {}, failure: undefined, saving: true });
    try {
      try {
        await lookups.ensure(
          model,
          [current.original],
          columns.map((column) => column.name),
        );
      } catch {
        if (fresh()) setSession({ ...current, failure: messages.loadError, saving: false });
        return;
      }
      if (!fresh()) return;
      const changes = changesOf(fields, current.original, current.drafts, (field) =>
        currencyOf(field, current.original),
      );
      const errors = Object.fromEntries(
        fields.flatMap((field) => {
          if (
            field.definition.type === 'monetary' &&
            Object.hasOwn(current.drafts, field.name) &&
            !isEditable(field, currencyOf(field, current.original))
          )
            return [[field.name, messages.problem.invalid]];
          const problem = changes.problems[field.name];
          return problem ? [[field.name, problemText(problem, field.label, messages)]] : [];
        }),
      );
      if (Object.keys(errors).length > 0) {
        setSession({ ...current, errors, failure: undefined, saving: false });
        return;
      }
      if (Object.keys(changes.values).length > 0) {
        await view.data.write(model, current.original.id, changes.values);
        if (!fresh()) return;
        setSession(undefined);
        setNotice(true);
        onSaved(); // Requery: sorting, domain membership and totals may all have changed.
      } else if (fresh()) setSession(undefined);
    } catch (error) {
      if (fresh())
        setSession({
          ...current,
          errors: error instanceof WriteFailure ? { ...error.fieldErrors } : {},
          failure: error instanceof WriteFailure ? error.message : messages.saveError,
          saving: false,
        });
    } finally {
      inFlightRef.current = false;
    }
  }
  return { session: current, canEdit, notice, begin, change, cancel, save };
}

export function ListInput({
  column,
  value,
  errorId,
  invalid,
  disabled,
  onChange,
}: {
  readonly column: Column;
  readonly value: Draft;
  readonly errorId: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onChange: (name: string, value: Draft) => void;
}): React.ReactElement {
  const messages = useMessages();
  const common = {
    name: column.name,
    'aria-label': column.label,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': invalid ? errorId : undefined,
    'data-inline-input': column.name,
    disabled,
    required: column.definition.required === true,
  };
  if (column.definition.type === 'boolean')
    return (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(event) => {
          onChange(column.name, event.currentTarget.checked);
        }}
      />
    );
  if (column.definition.type === 'selection')
    return (
      <select
        {...common}
        className="ui-input ve-inline-input"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => {
          onChange(column.name, event.currentTarget.value);
        }}
      >
        <option value="">{messages.choose}</option>
        {column.definition.selection?.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    );
  const numeric = ['integer', 'decimal', 'monetary'].includes(column.definition.type);
  return (
    <input
      {...common}
      className="ui-input ve-inline-input"
      type={column.definition.type === 'date' ? 'date' : 'text'}
      dir={numeric || column.widget === 'email' || column.widget === 'phone' ? 'ltr' : 'auto'}
      {...(numeric
        ? {
            inputMode:
              column.definition.type === 'integer' ? ('numeric' as const) : ('decimal' as const),
          }
        : {})}
      {...(column.definition.size === undefined ? {} : { maxLength: column.definition.size })}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => {
        onChange(column.name, event.currentTarget.value);
      }}
    />
  );
}
