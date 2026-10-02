// SPDX-License-Identifier: LGPL-3.0-only
// A card owns its edit session, held by the record so changing notebook pages keeps the draft.
import { Button, Card, IconButton } from '@socle/ui';
import { Pencil } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { useMessages, useViewContext } from './context.js';
import { changesOf, isEditable, toDraft, type Draft, type EditProblem } from './editing.js';
import { FormInput } from './form-input.js';
import type { FormField } from './form-model.js';
import type { Lookups } from './lookups.js';
import type { Messages } from './messages.js';
import { WriteFailure, type RecordValues } from './types.js';

export interface CardEdit {
  readonly original: RecordValues;
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly failure: string | undefined;
  readonly saving: boolean;
}

export interface CardEditing {
  readonly sessions: ReadonlyMap<string, CardEdit>;
  readonly change: (key: string, edit: CardEdit | undefined) => void;
  readonly saved: (values: Readonly<Record<string, unknown>>) => void;
}

function problemText(problem: EditProblem, label: string, messages: Messages): string {
  if (problem.code === 'required') return messages.problem.required(label);
  if (problem.code === 'decimals') return messages.problem.decimals(problem.max);
  return messages.problem[problem.code];
}

/** Move focus through the form's named controls, without interpolating names into CSS selectors. */
function focusField(form: HTMLFormElement | null, name: string | undefined): void {
  if (name === undefined) return;
  const control = form?.elements.namedItem(name);
  if (control instanceof HTMLElement) control.focus();
}

export function FormCard({
  cardKey,
  title,
  fields,
  record,
  model,
  lookups,
  editing,
  renderFields,
}: {
  readonly cardKey: string;
  readonly title: string | undefined;
  readonly fields: readonly FormField[];
  readonly record: RecordValues;
  readonly model: string;
  readonly lookups: Lookups;
  readonly editing: CardEditing;
  readonly renderFields: (fields: readonly FormField[]) => React.ReactNode;
}): React.ReactElement {
  const view = useViewContext();
  const messages = useMessages();
  const edit = editing.sessions.get(cardKey);
  const formRef = useRef<HTMLFormElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const wasEditingRef = useRef(false);
  const editingNow = edit !== undefined;
  const name = title ?? fields[0]?.label ?? messages.sections;
  const currencyOf = (field: FormField) => {
    const currencyField = field.definition.currencyField ?? 'currencyId';
    const currencyId =
      edit && Object.hasOwn(edit.drafts, currencyField)
        ? edit.drafts[currencyField]
        : record[currencyField];
    return lookups.currencyOf(currencyId);
  };
  const editable = fields.filter((field) => isEditable(field, currencyOf(field)));

  useEffect(() => {
    if (editingNow && !wasEditingRef.current) {
      const first = formRef.current?.querySelector<HTMLElement>('input, select, textarea');
      first?.focus();
    } else if (!editingNow && wasEditingRef.current) {
      triggerRef.current?.focus();
    }
    wasEditingRef.current = editingNow;
  }, [editingNow]);

  const begin = (): void => {
    const drafts = Object.fromEntries(
      editable.map((field) => [
        field.name,
        toDraft(field.definition, record[field.name], currencyOf(field)),
      ]),
    );
    editing.change(cardKey, {
      original: record,
      drafts,
      errors: {},
      failure: undefined,
      saving: false,
    });
  };

  const cancel = (): void => {
    if (!edit?.saving && !inFlightRef.current) editing.change(cardKey, undefined);
  };

  const save = async (): Promise<void> => {
    if (!edit || edit.saving || inFlightRef.current || !view.data.write) return;
    inFlightRef.current = true;
    editing.change(cardKey, { ...edit, errors: {}, failure: undefined, saving: true });
    let errors: Record<string, string> = {};
    try {
      // In particular, load a newly selected currency before interpreting any monetary input.
      const candidate = { ...record, ...edit.drafts, id: record.id };
      try {
        await lookups.ensure(
          model,
          [candidate],
          fields.map((field) => field.name),
        );
      } catch {
        editing.change(cardKey, { ...edit, failure: messages.loadError, saving: false });
        return;
      }
      const changes = changesOf(fields, edit.original, edit.drafts, currencyOf);
      errors = Object.fromEntries(
        fields.flatMap((field) => {
          if (
            field.definition.type === 'monetary' &&
            Object.hasOwn(edit.drafts, field.name) &&
            !isEditable(field, currencyOf(field))
          ) {
            return [[field.name, messages.problem.invalid]];
          }
          const problem = changes.problems[field.name];
          return problem ? [[field.name, problemText(problem, field.label, messages)]] : [];
        }),
      );
      if (Object.keys(errors).length > 0) {
        editing.change(cardKey, { ...edit, errors, failure: undefined, saving: false });
        return;
      }
      if (Object.keys(changes.values).length > 0) {
        await view.data.write(model, record.id, changes.values);
        editing.saved(changes.values);
      }
      editing.change(cardKey, undefined);
    } catch (error) {
      errors = error instanceof WriteFailure ? { ...error.fieldErrors } : {};
      editing.change(cardKey, {
        ...edit,
        errors,
        failure: error instanceof WriteFailure ? error.message : messages.saveError,
        saving: false,
      });
    } finally {
      inFlightRef.current = false;
      // Wait for React to re-enable the controls and attach the error descriptions.
      if (Object.keys(errors).length > 0) {
        requestAnimationFrame(() => {
          focusField(formRef.current, fields.find((field) => errors[field.name])?.name);
        });
      }
    }
  };

  return (
    <Card
      {...(title === undefined ? {} : { title })}
      actions={
        edit === undefined && view.data.write && editable.length > 0 ? (
          <IconButton
            ref={triggerRef}
            icon={Pencil}
            tone="plain"
            label={messages.edit(name)}
            onClick={begin}
          />
        ) : undefined
      }
    >
      {edit === undefined ? (
        renderFields(fields)
      ) : (
        <form
          ref={formRef}
          className="ve-form-editor"
          aria-label={messages.edit(name)}
          aria-busy={edit.saving}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              void save();
            }
          }}
        >
          {fields.some((field) => !Object.hasOwn(edit.drafts, field.name))
            ? renderFields(fields.filter((field) => !Object.hasOwn(edit.drafts, field.name)))
            : null}
          {fields
            .filter((field) => Object.hasOwn(edit.drafts, field.name))
            .map((field) => (
              <FormInput
                key={field.name}
                field={field}
                value={edit.drafts[field.name] ?? ''}
                currency={currencyOf(field)}
                displayName={
                  field.definition.comodel === undefined
                    ? undefined
                    : lookups.nameOf(field.definition.comodel, edit.drafts[field.name])
                }
                error={edit.errors[field.name]}
                disabled={edit.saving}
                onChange={(value) => {
                  const remaining = Object.fromEntries(
                    Object.entries(edit.errors).filter(([name]) => name !== field.name),
                  );
                  editing.change(cardKey, {
                    ...edit,
                    drafts: { ...edit.drafts, [field.name]: value },
                    errors: remaining,
                    failure: undefined,
                  });
                }}
              />
            ))}
          {edit.failure ? (
            <p className="ui-error" role="alert">
              {edit.failure}
            </p>
          ) : null}
          <div className="ve-form-actions">
            <Button type="submit" variant="primary" loading={edit.saving} disabled={edit.saving}>
              {edit.saving ? messages.saving : messages.save}
            </Button>
            <Button onClick={cancel} disabled={edit.saving}>
              {messages.cancel}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
