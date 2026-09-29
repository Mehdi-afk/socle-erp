// SPDX-License-Identifier: LGPL-3.0-only
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { accessibilityViolations } from '../src/testing/axe.js';

import { COPY } from './copy.js';
import { Guide } from './guide.js';

const user = userEvent.setup();
const root = document.documentElement;

async function choose(group: string, option: string): Promise<void> {
  const radios = screen.getByRole('group', { name: group });
  await user.click(within(radios).getByText(option));
}

describe('style guide', () => {
  it('shows every section, with the preferences applied to the page root', () => {
    render(<Guide />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Guide de style');
    for (const title of [
      'Couleurs',
      'Contrastes',
      'Typographie',
      'Formes et espacements',
      'Boutons',
      'Cartes et paires libellé/valeur',
      'Badges, pastilles d’état, avatars',
      'Navigation',
      'Champs de saisie',
      'États vides et chargement',
      'Anneau de focus',
      'Accent de la société',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    }
    expect([root.dataset.theme, root.dataset.density, root.lang, root.dir]).toEqual([
      'hybrid',
      'comfortable',
      'fr',
      'ltr',
    ]);
  });

  it('switches theme and density on the root element', async () => {
    render(<Guide />);
    await choose('Thème', 'Sombre');
    expect(root.dataset.theme).toBe('dark');
    await choose('Thème', 'Clair');
    expect(root.dataset.theme).toBe('light');
    await choose('Densité', 'Compacte');
    expect(root.dataset.density).toBe('compact');
    await choose('Thème', 'Hybride');
    await choose('Densité', 'Confortable');
    expect([root.dataset.theme, root.dataset.density]).toEqual(['hybrid', 'comfortable']);
  });

  it('turns the page right to left in Arabic and back', async () => {
    render(<Guide />);
    await choose('Langue', 'العربية');
    expect([root.lang, root.dir]).toEqual(['ar', 'rtl']);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(COPY.ar.title);
    // The controls and the samples are in Arabic too.
    expect(screen.getByRole('group', { name: COPY.ar.theme })).toBeInTheDocument();
    expect(screen.getAllByText(COPY.ar.person).length).toBeGreaterThan(0);
    await choose(COPY.ar.language, 'English');
    expect([root.lang, root.dir]).toEqual(['en', 'ltr']);
    await choose('Language', 'Français');
    expect([root.lang, root.dir]).toEqual(['fr', 'ltr']);
  });

  it('computes every contrast live and passes them all in each theme', async () => {
    render(<Guide />);
    for (const theme of ['Hybride', 'Sombre', 'Clair']) {
      await choose('Thème', theme);
      const table = screen.getByRole('table', { name: 'Contrastes' });
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows.length, theme).toBeGreaterThan(30);
      expect(within(table).queryByText('Insuffisant'), theme).not.toBeInTheDocument();
      expect(within(table).getAllByText('Conforme').length, theme).toBe(rows.length);
    }
  });

  it('reveals the confidential values only on request', async () => {
    render(<Guide />);
    expect(screen.queryByText('000 123 456 789 012')).not.toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Afficher' });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    await user.click(show);
    expect(show).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('000 123 456 789 012')).toBeVisible();
    await user.click(show);
    expect(screen.queryByText('000 123 456 789 012')).not.toBeInTheDocument();
  });

  it('applies a custom accent only when the text on it stays readable', async () => {
    render(<Guide />);
    const field = screen.getByRole('textbox', { name: 'Accent de la société' });
    await user.clear(field);
    await user.type(field, '#F59E0B');
    expect(screen.getByText('Accent accepté')).toBeVisible();
    expect(root.style.getPropertyValue('--color-accent')).toBe('#F59E0B');
    expect(root.style.getPropertyValue('--color-on-accent')).toBe('#1B1B1D');

    await user.clear(field);
    await user.type(field, '#777777');
    expect(screen.getByText('Accent refusé')).toBeVisible();
    expect(screen.getByText(/is required/)).toBeVisible();
    // A refused accent is not applied: the page returns to the default.
    expect(root.style.getPropertyValue('--color-accent')).toBe('');
  });

  it('has no accessibility violation, in each language and each theme', async () => {
    const { container } = render(<Guide />);
    expect(await accessibilityViolations(container)).toEqual([]);
    await choose('Langue', 'العربية');
    expect(await accessibilityViolations(container)).toEqual([]);
    await choose(COPY.ar.theme, COPY.ar.themes.light);
    expect(await accessibilityViolations(container)).toEqual([]);
    await choose(COPY.ar.theme, COPY.ar.themes.dark);
    expect(await accessibilityViolations(container)).toEqual([]);
  }, 60_000);
});
