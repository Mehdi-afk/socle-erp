// SPDX-License-Identifier: LGPL-3.0-only
import { isStoredColumn } from '@socle/framework';
import { Button, Checkbox, SelectField, TextField } from '@socle/ui';
import { useEffect, useId, useState } from 'react';

import { useMessages, useViewContext } from './context.js';
import type { Draft } from './editing.js';
import type { Currency } from './format.js';
import type { FormField } from './form-model.js';
import type { DataSource } from './types.js';

export interface FormInputProps {
  readonly field: FormField;
  readonly value: Draft;
  readonly currency: Currency | undefined;
  readonly displayName: string | undefined;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: Draft) => void;
}

/** A field's draft input. Relations can only choose records returned by the data source. */
export function FormInput(props: FormInputProps): React.ReactElement {
  const { field, value, currency, error, disabled, onChange } = props;
  const messages = useMessages();
  const common = {
    name: field.name,
    label: field.label,
    required: field.definition.required === true,
    disabled,
    ...(error === undefined ? {} : { error }),
  };
  switch (field.definition.type) {
    case 'boolean':
      return (
        <Checkbox
          {...common}
          checked={value === true}
          onChange={(event) => {
            onChange(event.currentTarget.checked);
          }}
        />
      );
    case 'text':
      return <TextArea {...props} />;
    case 'selection':
      return (
        <SelectField
          {...common}
          value={typeof value === 'string' ? value : ''}
          placeholder={messages.choose}
          options={(field.definition.selection ?? []).map(([key, label]) => ({
            value: key,
            label,
          }))}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      );
    case 'many2one':
      return <RelatedInput {...props} />;
    default: {
      const type = field.definition.type;
      const numeric = type === 'integer' || type === 'decimal' || type === 'monetary';
      const inputType =
        type === 'date'
          ? 'date'
          : field.widget === 'phone'
            ? 'tel'
            : field.widget === 'email'
              ? 'email'
              : field.widget === 'url'
                ? 'url'
                : 'text';
      return (
        <TextField
          {...common}
          type={inputType}
          dir={numeric || inputType !== 'text' ? 'ltr' : 'auto'}
          {...(numeric ? { inputMode: type === 'integer' ? 'numeric' : 'decimal' } : {})}
          {...(type === 'monetary' && currency !== undefined ? { hint: currency.code } : {})}
          {...(field.definition.size === undefined ? {} : { maxLength: field.definition.size })}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      );
    }
  }
}

function TextArea({ field, value, error, disabled, onChange }: FormInputProps): React.ReactElement {
  const id = useId();
  const errorId = `${id}-error`;
  const required = field.definition.required === true;
  return (
    <div className="ui-control">
      <label className="ui-label" htmlFor={id}>
        {field.label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <textarea
        id={id}
        name={field.name}
        className="ui-input"
        rows={4}
        required={required}
        disabled={disabled}
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={error === undefined ? undefined : errorId}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      {error === undefined ? null : (
        <p id={errorId} className="ui-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface Choice {
  readonly value: string;
  readonly label: string;
}

interface RelatedResult {
  readonly source: DataSource;
  readonly model: string;
  readonly language: string;
  readonly query: string;
  readonly attempt: number;
  readonly status: 'ready' | 'failed';
  readonly choices: readonly Choice[];
}

function RelatedInput({
  field,
  value,
  displayName,
  error,
  disabled,
  onChange,
}: FormInputProps): React.ReactElement {
  const { data, registry, language } = useViewContext();
  const messages = useMessages();
  const model = field.definition.comodel ?? '';
  const fields = registry.get(model).fields;
  const searchable = [...fields].filter(
    ([name, definition]) =>
      name !== 'id' &&
      definition.type === 'char' &&
      definition.sensitive !== true &&
      isStoredColumn(definition),
  );
  const searchField = searchable.find(([name]) => name === 'name')?.[0] ?? searchable[0]?.[0];
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<RelatedResult>();
  const [chosen, setChosen] = useState<Choice>();
  const current = typeof value === 'string' ? value : '';
  const fresh =
    result?.source === data &&
    result.model === model &&
    result.language === language &&
    result.query === query &&
    result.attempt === attempt;
  const status = fresh ? result.status : 'loading';
  const choices = fresh && result.status === 'ready' ? result.choices : [];
  const options =
    current === '' || choices.some((choice) => choice.value === current)
      ? choices
      : [
          {
            value: current,
            label: chosen?.value === current ? chosen.label : (displayName ?? current),
          },
          ...choices,
        ];

  useEffect(() => {
    let active = true;
    const isCurrent = (): boolean => active;
    const timer = setTimeout(
      () => {
        const load = async (): Promise<void> => {
          try {
            const found = await data.search(model, {
              fields: searchField === undefined ? [] : [searchField],
              ...(searchField === undefined ? {} : { order: searchField }),
              ...(searchField === undefined || query.trim() === ''
                ? {}
                : { domain: [[searchField, 'ilike', query.trim()]] }),
              limit: 50,
              offset: 0,
            });
            if (!isCurrent()) return;
            const records = found.records.slice(0, 50);
            const names = await data.displayNames(
              model,
              records.map((record) => record.id),
            );
            if (!isCurrent()) return;
            setResult({
              source: data,
              model,
              language,
              query,
              attempt,
              status: 'ready',
              choices: records.map((record) => ({
                value: record.id,
                label: names.get(record.id) ?? record.id,
              })),
            });
          } catch {
            if (isCurrent()) {
              setResult({
                source: data,
                model,
                language,
                query,
                attempt,
                status: 'failed',
                choices: [],
              });
            }
          }
        };
        void load();
      },
      query === '' ? 0 : 200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, model, language, searchField, query, attempt]);

  return (
    <div className="ve-form-relation-input">
      <TextField
        name={`${field.name}:search`}
        label={messages.searchRelated(field.label)}
        type="search"
        value={query}
        disabled={disabled || searchField === undefined}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
      />
      <SelectField
        name={field.name}
        label={field.label}
        required={field.definition.required === true}
        value={current}
        options={options}
        placeholder={messages.choose}
        disabled={disabled || status !== 'ready'}
        {...(error === undefined ? {} : { error })}
        onChange={(event) => {
          if (disabled || status !== 'ready') return;
          const next = event.currentTarget.value;
          const choice = options.find((option) => option.value === next);
          if (next !== '' && choice === undefined) return;
          setChosen(choice);
          onChange(next);
        }}
      />
      {status === 'loading' ? <p role="status">{messages.loading}</p> : null}
      {status === 'ready' && choices.length === 0 ? <p role="status">{messages.empty}</p> : null}
      {status === 'failed' ? (
        <div>
          <p className="ui-error" role="alert">
            {messages.loadError}
          </p>
          <Button
            disabled={disabled}
            onClick={() => {
              setAttempt((count) => count + 1);
            }}
          >
            {messages.retry}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
