// SPDX-License-Identifier: LGPL-3.0-only
import { applyViewChanges, field } from '@socle/framework';
import {
  applyPreferences,
  directionOf,
  SegmentedControl,
  UiProvider,
  type ThemeName,
} from '@socle/ui';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../../ui/src/styles.css';
import { ViewEngineProvider } from '../src/context.js';
import { FormView } from '../src/form-view.js';
import { ListView } from '../src/list-view.js';
import { contactForm, fixture, listArch } from '../src/testing/fixtures.js';
import type { Density } from '../src/types.js';
import './demo.css';

type Language = 'fr' | 'en' | 'ar';

const demoForm = applyViewChanges(
  contactForm,
  [
    {
      at: "group[name='main'] > field[name='kind']",
      position: 'before',
      nodes: [field('name'), field('email', { widget: 'email' })],
    },
  ],
  'Editable contact demo',
);

const fromAddress = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.find((candidate) => candidate === value) ?? fallback;
};

function Demo(): React.ReactElement {
  const [theme, setTheme] = useState<ThemeName>(() =>
    fromAddress('theme', ['hybrid', 'dark', 'light'], 'hybrid'),
  );
  const [language, setLanguage] = useState<Language>(() =>
    fromAddress('lang', ['fr', 'en', 'ar'], 'fr'),
  );
  const [density, setDensity] = useState<Density>(() =>
    fromAddress('density', ['comfortable', 'compact'], 'comfortable'),
  );
  const [openId, setOpenId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get('id') ?? undefined,
  );

  useEffect(() => {
    applyPreferences(document.documentElement, { theme, density, language });
  }, [theme, density, language]);

  const [demo] = useState(() => fixture(5000, {}, 120));
  const context = useMemo(
    () => ({ ...demo.context, language, density }),
    [demo, language, density],
  );

  return (
    <UiProvider dir={directionOf(language)}>
      <ViewEngineProvider context={context}>
        <div className="demo">
          <div className="demo-bar">
            <SegmentedControl<ThemeName>
              label="Thème"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'hybrid', label: 'Hybride' },
                { value: 'dark', label: 'Sombre' },
                { value: 'light', label: 'Clair' },
              ]}
            />
            <SegmentedControl<Language>
              label="Langue"
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'fr', label: 'Français' },
                { value: 'en', label: 'English' },
                { value: 'ar', label: 'العربية' },
              ]}
            />
            <SegmentedControl<Density>
              label="Densité"
              value={density}
              onChange={setDensity}
              options={[
                { value: 'comfortable', label: 'Confortable' },
                { value: 'compact', label: 'Compacte' },
              ]}
            />
          </div>
          {openId === undefined ? (
            <ListView
              arch={listArch}
              model="res.partner"
              label="Contacts"
              onOpen={setOpenId}
              viewportHeight={560}
            />
          ) : (
            <>
              <button
                type="button"
                className="demo-back"
                onClick={() => {
                  setOpenId(undefined);
                }}
              >
                ← Retour à la liste
              </button>
              <FormView
                arch={demoForm}
                model="res.partner"
                id={openId}
                onReveal={() =>
                  new Promise((resolve) =>
                    setTimeout(() => {
                      resolve('0009 8765 4321 0');
                    }, 300),
                  )
                }
                onOpenRelated={(_model, id) => {
                  setOpenId(id);
                }}
              />
            </>
          )}
        </div>
      </ViewEngineProvider>
    </UiProvider>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Demo />);
