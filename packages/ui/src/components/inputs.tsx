// SPDX-License-Identifier: LGPL-3.0-only
import { useId } from 'react';

import './inputs.css';

interface FieldMessages {
  /** Help shown under the field and read with it. */
  readonly hint?: string;
  /** What is wrong. Marks the field invalid and is read with it. */
  readonly error?: string;
}

/** The ids that tie a field to its hint and its error (`aria-describedby`). */
function useFieldIds(messages: FieldMessages): {
  readonly id: string;
  readonly hintId: string;
  readonly errorId: string;
  readonly describedBy: string | undefined;
} {
  const baseId = useId();
  const [hintId, errorId] = [`${baseId}-hint`, `${baseId}-error`];
  const ids = [
    ...(messages.hint === undefined ? [] : [hintId]),
    ...(messages.error === undefined ? [] : [errorId]),
  ];
  return { id: baseId, hintId, errorId, describedBy: ids.length > 0 ? ids.join(' ') : undefined };
}

function Messages({
  hint,
  error,
  hintId,
  errorId,
}: FieldMessages & { readonly hintId: string; readonly errorId: string }): React.ReactElement {
  return (
    <>
      {hint === undefined ? null : (
        <p id={hintId} className="ui-hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="ui-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

const Label = ({
  htmlFor,
  required,
  children,
}: {
  readonly htmlFor: string;
  readonly required: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement => (
  <label className="ui-label" htmlFor={htmlFor}>
    {children}
    {required ? <span aria-hidden="true"> *</span> : null}
  </label>
);

export interface TextFieldProps
  extends
    FieldMessages,
    Omit<React.ComponentPropsWithoutRef<'input'>, 'id' | 'aria-describedby' | 'aria-invalid'> {
  readonly label: string;
  readonly ref?: React.Ref<HTMLInputElement>;
}

/** A text (or number, date, email…) field with its label, hint and error tied to it. */
export function TextField({
  label,
  hint,
  error,
  required = false,
  ...rest
}: TextFieldProps): React.ReactElement {
  const { id, hintId, errorId, describedBy } = useFieldIds({
    ...(hint === undefined ? {} : { hint }),
    ...(error === undefined ? {} : { error }),
  });
  return (
    <div className="ui-control">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <input
        {...rest}
        id={id}
        className="ui-input"
        required={required}
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={describedBy}
      />
      <Messages
        {...(hint === undefined ? {} : { hint })}
        {...(error === undefined ? {} : { error })}
        hintId={hintId}
        errorId={errorId}
      />
    </div>
  );
}

export interface SelectFieldProps
  extends
    FieldMessages,
    Omit<
      React.ComponentPropsWithoutRef<'select'>,
      'id' | 'aria-describedby' | 'aria-invalid' | 'children'
    > {
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** A first, empty choice ("Choose…"); its value is the empty string. */
  readonly placeholder?: string;
  readonly ref?: React.Ref<HTMLSelectElement>;
}

/** A native select: the operating system's own picker, accessible everywhere. */
export function SelectField({
  label,
  hint,
  error,
  options,
  placeholder,
  required = false,
  ...rest
}: SelectFieldProps): React.ReactElement {
  const { id, hintId, errorId, describedBy } = useFieldIds({
    ...(hint === undefined ? {} : { hint }),
    ...(error === undefined ? {} : { error }),
  });
  return (
    <div className="ui-control">
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <select
        {...rest}
        id={id}
        className="ui-input ui-select"
        required={required}
        aria-invalid={error === undefined ? undefined : 'true'}
        aria-describedby={describedBy}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Messages
        {...(hint === undefined ? {} : { hint })}
        {...(error === undefined ? {} : { error })}
        hintId={hintId}
        errorId={errorId}
      />
    </div>
  );
}

export interface ToggleProps
  extends
    FieldMessages,
    Omit<
      React.ComponentPropsWithoutRef<'input'>,
      'id' | 'type' | 'role' | 'aria-describedby' | 'aria-invalid'
    > {
  readonly label: string;
  readonly ref?: React.Ref<HTMLInputElement>;
}

function Toggle({
  kind,
  label,
  hint,
  error,
  ...rest
}: ToggleProps & { readonly kind: 'checkbox' | 'switch' }): React.ReactElement {
  const { id, hintId, errorId, describedBy } = useFieldIds({
    ...(hint === undefined ? {} : { hint }),
    ...(error === undefined ? {} : { error }),
  });
  return (
    <div className="ui-control" data-kind={kind}>
      <div className="ui-toggle">
        <input
          {...rest}
          id={id}
          type="checkbox"
          role={kind === 'switch' ? 'switch' : undefined}
          className="ui-toggle-input"
          aria-invalid={error === undefined ? undefined : 'true'}
          aria-describedby={describedBy}
        />
        <label className="ui-toggle-label" htmlFor={id}>
          {label}
        </label>
      </div>
      <Messages
        {...(hint === undefined ? {} : { hint })}
        {...(error === undefined ? {} : { error })}
        hintId={hintId}
        errorId={errorId}
      />
    </div>
  );
}

/** A checkbox with its label. */
export function Checkbox(props: ToggleProps): React.ReactElement {
  return <Toggle {...props} kind="checkbox" />;
}

/** An on/off switch (announced as a switch, not a checkbox). */
export function Switch(props: ToggleProps): React.ReactElement {
  return <Toggle {...props} kind="switch" />;
}
