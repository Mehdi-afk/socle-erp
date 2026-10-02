// SPDX-License-Identifier: LGPL-3.0-only
import { SelectField, type Preferences } from '@socle/ui';
import { Settings2 } from 'lucide-react';
import { z } from 'zod';

import { copyFor } from './copy.js';

const language = z.enum(['fr', 'en', 'ar']);
const theme = z.enum(['hybrid', 'dark', 'light']);
const density = z.enum(['comfortable', 'compact']);
export const DEFAULT_PREFERENCES: Preferences = {
  language: 'fr',
  theme: 'hybrid',
  density: 'comfortable',
};

export function PreferenceControls({
  value,
  onChange,
}: {
  readonly value: Preferences;
  readonly onChange: (value: Preferences) => void;
}): React.ReactElement {
  const copy = copyFor(value.language);
  return (
    <details className="web-preferences">
      <summary>
        <Settings2 size={16} aria-hidden="true" />
        {copy.preferences}
      </summary>
      <div className="web-preferences-panel">
        <SelectField
          label={copy.language}
          value={value.language}
          options={[
            { value: 'fr', label: 'Français' },
            { value: 'en', label: 'English' },
            { value: 'ar', label: 'العربية' },
          ]}
          onChange={(event) => {
            const parsed = language.safeParse(event.target.value);
            if (parsed.success) onChange({ ...value, language: parsed.data });
          }}
        />
        <SelectField
          label={copy.theme}
          value={value.theme}
          options={[
            { value: 'hybrid', label: copy.hybrid },
            { value: 'dark', label: copy.dark },
            { value: 'light', label: copy.light },
          ]}
          onChange={(event) => {
            const parsed = theme.safeParse(event.target.value);
            if (parsed.success) onChange({ ...value, theme: parsed.data });
          }}
        />
        <SelectField
          label={copy.density}
          value={value.density}
          options={[
            { value: 'comfortable', label: copy.comfortable },
            { value: 'compact', label: copy.compact },
          ]}
          onChange={(event) => {
            const parsed = density.safeParse(event.target.value);
            if (parsed.success) onChange({ ...value, density: parsed.data });
          }}
        />
      </div>
    </details>
  );
}
