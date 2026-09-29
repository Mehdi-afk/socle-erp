// SPDX-License-Identifier: LGPL-3.0-only
import { useId } from 'react';

import './segmented.css';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: React.ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  /** What the choice is about ("View": Day / Week / Month): the group is named. */
  readonly label: string;
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

/**
 * A pill with one segment selected (Day / Week / Month). It is a group of native radio buttons:
 * the browser gives the keyboard behaviour (arrows move and select, and follow the reading
 * direction), assistive technologies read "n of N".
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedControlProps<T>): React.ReactElement {
  const groupId = useId();
  return (
    <fieldset className="ui-segmented">
      <legend className="ui-sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="ui-segment">
          <input
            className="ui-sr-only"
            type="radio"
            name={groupId}
            value={option.value}
            checked={value === option.value}
            onChange={() => {
              onChange(option.value);
            }}
          />
          <span className="ui-segment-label">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
