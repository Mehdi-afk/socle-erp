// SPDX-License-Identifier: LGPL-3.0-only
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { accessibilityViolations } from '../../ui/src/testing/axe.js';

import { ViewEngineProvider } from './context.js';
import type { Draft } from './editing.js';
import { FormInput, type FormInputProps } from './form-input.js';
import type { FormField } from './form-model.js';
import { fixture, registry } from './testing/fixtures.js';
import type { SearchResult, ViewContext } from './types.js';

function field(name: string): FormField {
  const definition = registry.get('res.partner').fields.get(name);
  if (!definition) throw new Error(`Missing fixture field: ${name}`);
  return {
    name,
    definition,
    label: definition.label?.fr ?? name,
    widget: undefined,
    tones: undefined,
    sensitive: false,
    readonly: false,
  };
}

function Controlled(props: FormInputProps): React.ReactElement {
  const [value, setValue] = useState(props.value);
  return (
    <form>
      <FormInput
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          props.onChange(next);
        }}
      />
    </form>
  );
}

function show(name: string, context: ViewContext, overrides: Partial<FormInputProps> = {}) {
  const onChange = vi.fn<(value: Draft) => void>();
  return {
    onChange,
    ...render(
      <ViewEngineProvider context={context}>
        <Controlled
          field={field(name)}
          value=""
          currency={undefined}
          displayName={undefined}
          error={undefined}
          disabled={false}
          onChange={onChange}
          {...overrides}
        />
      </ViewEngineProvider>,
    ),
  };
}

describe('form inputs', () => {
  it('keeps multiline prose and associates its validation error with the textarea', async () => {
    const user = userEvent.setup();
    const { context } = fixture(1);
    const { onChange, container } = show('notes', context, {
      value: 'First line\nSecond line',
      error: 'Une précision est nécessaire.',
    });
    const input = screen.getByRole('textbox', { name: 'Notes' });
    expect(input.tagName).toBe('TEXTAREA');
    expect(input).toHaveAttribute('name', 'notes');
    expect(input).toHaveAccessibleDescription('Une précision est nécessaire.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.type(input, '  ');
    expect(onChange).toHaveBeenLastCalledWith('First line\nSecond line  ');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('accepts comma decimals as text and announces the currency', async () => {
    const user = userEvent.setup();
    const { context } = fixture(1);
    const { onChange } = show('revenue', context, { currency: { code: 'DZD', decimals: 2 } });
    const input = screen.getByRole('textbox', { name: 'Chiffre d’affaires' });
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveAccessibleDescription('DZD');
    await user.type(input, '12,50');
    expect(onChange).toHaveBeenLastCalledWith('12,50');
  });

  it('keeps phone, email, URL, amount and date inputs left-to-right inside an Arabic form', () => {
    const { context } = fixture(1, { language: 'ar' });
    const date: FormField = {
      ...field('lastContact'),
      definition: { ...field('lastContact').definition, type: 'date' },
      label: 'التاريخ',
    };
    const inputs = [
      {
        field: { ...field('phone'), label: 'الهاتف', widget: 'phone' },
        value: '0555 12 34 00',
        type: 'tel',
        direction: 'ltr',
      },
      {
        field: { ...field('email'), label: 'البريد', widget: 'email' },
        value: 'contact@example.test',
        type: 'email',
        direction: 'ltr',
      },
      {
        field: { ...field('website'), label: 'الموقع', widget: 'url' },
        value: 'https://example.test/contact',
        type: 'url',
        direction: 'ltr',
      },
      {
        field: { ...field('revenue'), label: 'المبلغ' },
        value: '1234.50',
        type: 'text',
        direction: 'ltr',
      },
      { field: date, value: '2026-10-02', type: 'date', direction: 'ltr' },
      {
        field: { ...field('name'), label: 'الاسم' },
        value: 'أمل بن علي',
        type: 'text',
        direction: 'auto',
      },
    ];
    render(
      <div dir="rtl">
        <ViewEngineProvider context={context}>
          {inputs.map((input) => (
            <Controlled
              key={input.field.name}
              field={input.field}
              value={input.value}
              currency={{ code: 'DZD', decimals: 2 }}
              displayName={undefined}
              error={undefined}
              disabled={false}
              onChange={vi.fn()}
            />
          ))}
        </ViewEngineProvider>
      </div>,
    );

    for (const input of inputs) {
      const control = screen.getByLabelText(input.field.label, { exact: false });
      expect(control).toHaveAttribute('type', input.type);
      expect(control).toHaveAttribute('dir', input.direction);
      expect(control).toHaveValue(input.value);
    }
  });
});

describe('searching for a related record', () => {
  it('limits the first page, searches other records and always keeps the selected record', async () => {
    const user = userEvent.setup();
    const { data, context } = fixture(1);
    data.set(
      'res.country',
      Array.from({ length: 61 }, (_, index) => ({
        id: `country-${String(index)}`,
        name: `Country ${String(index).padStart(2, '0')}`,
      })),
    );
    const { onChange } = show('countryId', context, {
      value: 'country-60',
      displayName: 'Country 60',
    });
    const select = screen.getByRole('combobox', { name: 'Pays' });
    expect(select).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Country 60' })).toBeInTheDocument();
    await waitFor(() => expect(select).toBeEnabled());
    expect(screen.getAllByRole('option')).toHaveLength(52);
    expect(screen.queryByRole('option', { name: 'Country 59' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Rechercher : Pays' }), 'Country 59');
    expect(select).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'Country 00' })).not.toBeInTheDocument();
    await screen.findByRole('option', { name: 'Country 59' });
    await user.selectOptions(select, 'country-59');
    expect(onChange).toHaveBeenLastCalledWith('country-59');
    expect(data.searches.at(-1)).toMatchObject({
      domain: [['name', 'ilike', 'Country 59']],
      limit: 50,
      offset: 0,
    });
    expect((select.closest('form') as HTMLFormElement).elements.namedItem('countryId')).toBe(
      select,
    );
    await user.clear(screen.getByRole('searchbox', { name: 'Rechercher : Pays' }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue('country-59');
    expect(screen.getByRole('option', { name: 'Country 59' })).toBeInTheDocument();
  });

  it('ignores a slow old response and never allows an obsolete choice while loading', async () => {
    const user = userEvent.setup();
    const { data, context } = fixture(1);
    const pending = Promise.withResolvers<SearchResult>();
    const search = vi.spyOn(data, 'search');
    search.mockResolvedValueOnce({ records: [{ id: 'initial', name: 'Initial' }], total: 1 });
    search.mockImplementationOnce(() => pending.promise);
    search.mockResolvedValue({ records: [{ id: 'new', name: 'New' }], total: 1 });
    vi.spyOn(data, 'displayNames').mockImplementation((_model, ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, id]))),
    );
    const { onChange } = show('countryId', context);
    const select = screen.getByRole('combobox', { name: 'Pays' });
    await waitFor(() => expect(select).toBeEnabled());
    const input = screen.getByRole('searchbox', { name: 'Rechercher : Pays' });
    await user.type(input, 'old');
    await waitFor(() => {
      expect(search).toHaveBeenCalledTimes(2);
    });
    expect(select).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'initial' })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'new');
    await screen.findByRole('option', { name: 'new' });
    await act(async () => {
      pending.resolve({ records: [{ id: 'old', name: 'Old' }], total: 1 });
      await pending.promise;
    });
    expect(screen.queryByRole('option', { name: 'old' })).not.toBeInTheDocument();
    await user.selectOptions(select, 'new');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('new');
  });

  it('reports a failed lookup and retries without changing the current relation', async () => {
    const user = userEvent.setup();
    const { data, context } = fixture(1);
    vi.spyOn(data, 'search').mockRejectedValueOnce(new Error('offline'));
    const { onChange, container } = show('countryId', context, {
      value: 'c-dz',
      displayName: 'Algérie',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger');
    const select = screen.getByRole('combobox', { name: 'Pays' });
    expect(select).toBeDisabled();
    expect(select).toHaveValue('c-dz');
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue('c-dz');
    expect(onChange).not.toHaveBeenCalled();
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
