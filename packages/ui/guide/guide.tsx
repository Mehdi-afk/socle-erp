// SPDX-License-Identifier: LGPL-3.0-only
//
// The style guide page: switches at the top (theme, language, density), then every token and
// component in its states. It is built only from the design system itself.
import { useEffect, useMemo, useState } from 'react';

import {
  applyPreferences,
  deriveAccent,
  directionOf,
  SegmentedControl,
  UiProvider,
  type Density,
  type ThemeName,
} from '../src/index.js';

import { COPY, LANGUAGES, type Language } from './copy.js';
import {
  AccentSection,
  BadgesSection,
  ButtonsSection,
  CardsSection,
  ColorsSection,
  ContrastSection,
  FeedbackSection,
  FieldsSection,
  FocusSection,
  NavigationSection,
  ShapesSection,
  TypographySection,
} from './sections.js';

const LANGUAGE_LABELS: Readonly<Record<Language, React.ReactNode>> = {
  fr: 'Français',
  en: 'English',
  ar: <span lang="ar">العربية</span>,
};

/** A choice from the address (`?theme=dark&lang=ar&density=compact`), or the default. */
function fromAddress<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function Guide(): React.ReactElement {
  const [theme, setTheme] = useState<ThemeName>(() =>
    fromAddress('theme', ['hybrid', 'dark', 'light'], 'hybrid'),
  );
  const [language, setLanguage] = useState<Language>(() => fromAddress('lang', LANGUAGES, 'fr'));
  const [density, setDensity] = useState<Density>(() =>
    fromAddress('density', ['comfortable', 'compact'], 'comfortable'),
  );
  const [accent, setAccent] = useState('#EBFF65');
  const copy = COPY[language];

  // The choices live on the root element, where tokens.css reads them.
  useEffect(() => {
    applyPreferences(document.documentElement, { theme, density, language });
  }, [theme, density, language]);

  // A custom accent only applies when it passes the readability rules.
  const checked = useMemo(() => deriveAccent(accent), [accent]);
  useEffect(() => {
    const style = document.documentElement.style;
    if (checked.ok) {
      style.setProperty('--color-accent', checked.tokens.accent);
      style.setProperty('--color-on-accent', checked.tokens.onAccent);
      style.setProperty('--color-accent-soft', checked.tokens.accentSoft);
    }
    return () => {
      for (const name of ['--color-accent', '--color-on-accent', '--color-accent-soft']) {
        style.removeProperty(name);
      }
    };
  }, [checked]);

  return (
    <UiProvider dir={directionOf(language)}>
      <div className="guide">
        <header className="guide-header">
          <h1 className="guide-title">Socle · {copy.title}</h1>
          <p className="guide-intro">{copy.intro}</p>
          <div className="guide-controls">
            <SegmentedControl
              label={copy.theme}
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'hybrid', label: copy.themes.hybrid },
                { value: 'dark', label: copy.themes.dark },
                { value: 'light', label: copy.themes.light },
              ]}
            />
            <SegmentedControl
              label={copy.language}
              value={language}
              onChange={setLanguage}
              options={LANGUAGES.map((value) => ({ value, label: LANGUAGE_LABELS[value] }))}
            />
            <SegmentedControl
              label={copy.density}
              value={density}
              onChange={setDensity}
              options={[
                { value: 'comfortable', label: copy.densities.comfortable },
                { value: 'compact', label: copy.densities.compact },
              ]}
            />
          </div>
        </header>
        <main className="guide-main">
          <ColorsSection copy={copy} theme={theme} />
          <ContrastSection copy={copy} theme={theme} />
          <TypographySection copy={copy} />
          <ShapesSection copy={copy} />
          <ButtonsSection copy={copy} />
          <CardsSection copy={copy} />
          <BadgesSection copy={copy} />
          <NavigationSection copy={copy} />
          <FieldsSection copy={copy} />
          <FeedbackSection copy={copy} />
          <FocusSection copy={copy} />
          <AccentSection copy={copy} value={accent} onChange={setAccent} />
        </main>
      </div>
    </UiProvider>
  );
}
