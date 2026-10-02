// SPDX-License-Identifier: LGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axe from 'axe-core';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createWebBrowserFixture, type WebBrowserFixture } from './fixture.js';

let fixture: WebBrowserFixture;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let evidence: string;
let errors: string[];
let expectedUnauthenticated: Set<string>;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  fixture = await createWebBrowserFixture(inject('pgUrl'));
  cleanup.push(() => fixture.close());
  try {
    browser = await chromium.launch({ headless: true });
    cleanup.push(() => browser.close());
    evidence = await mkdtemp(join(tmpdir(), 'socle-web-browser-'));
    console.log(`Browser screenshots: ${evidence}`);
  } catch (error) {
    await fixture.close();
    throw error;
  }
});

afterAll(async () => {
  for (const close of cleanup.reverse()) await close();
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'fr-FR' });
  page = await context.newPage();
  errors = [];
  expectedUnauthenticated = new Set(['/auth/session']);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // A fresh anonymous page and the explicit expired-session case legitimately return 401.
    const location = message.location().url;
    const path = location.startsWith(fixture.url) ? new URL(location).pathname : '';
    const expected401 =
      expectedUnauthenticated.has(path) &&
      /^Failed to load resource: the server responded with a status of 401\b/.test(message.text());
    if (message.type() === 'error' && !expected401) {
      errors.push(message.text());
    }
  });
  await page.goto(fixture.url);
});

afterEach(async () => {
  try {
    expect(await page.locator('vite-error-overlay').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

async function signIn(role: 'manager' | 'reader' = 'manager'): Promise<void> {
  await page.getByLabel(/^Identifiant\b/).fill(fixture.credentials[role].login);
  await page.getByLabel(/^Mot de passe\b/).fill(fixture.credentials[role].password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.getByRole('button', { name: 'Se déconnecter', exact: true }).waitFor();
}

async function openContacts(): Promise<void> {
  const desktop = page
    .getByRole('navigation', { name: 'Mes données' })
    .getByRole('button', { name: /^Contacts?$/ });
  if (await desktop.isVisible()) await desktop.click();
  else await page.getByLabel('Vue', { exact: true }).selectOption('res.partner');
  await page.getByRole('grid').waitFor();
}

async function openAtlas(): Promise<void> {
  const record = await fixture.readContact();
  const row = page.getByRole('row').filter({ has: page.getByText(record.name, { exact: true }) });
  await row.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Modifier : Nom', exact: true }).waitFor();
}

async function checkAccessibility(name: string): Promise<void> {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const engine = (globalThis as unknown as { axe: typeof axe }).axe;
    const result = await engine.run({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
  });
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  expect(violations).toEqual([]);
}

describe('web client with real PostgreSQL and browser cookies', () => {
  it('signs in, edits a real base record and keeps the committed value after reload and logout', async () => {
    expect(await page.title()).not.toBe('');
    await page.getByRole('button', { name: 'Se connecter', exact: true }).waitFor();
    await checkAccessibility('login-fr');
    const requests: { method: string; path: string }[] = [];
    page.on('request', (request) => {
      requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    await signIn();
    const cookie = (await context.cookies()).find((entry) => entry.name === '__Host-socle_session');
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { document: { cookie: string } }).document.cookie,
      ),
    ).not.toContain('__Host-socle_session');
    expect(requests).toContainEqual({ method: 'POST', path: '/auth/login' });
    expect(requests).toContainEqual({ method: 'POST', path: '/web/metadata' });
    await openContacts();
    await page.getByText('Atelier Atlas', { exact: true }).waitFor();
    await checkAccessibility('contacts-fr');
    await openAtlas();
    await checkAccessibility('contact-fr');
    await page.getByRole('button', { name: 'Modifier : Nom', exact: true }).click();
    await page.getByLabel(/^Nom\b/).fill('Atelier Atlas modifié');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await page.getByText('Modifications enregistrées.', { exact: true }).waitFor();
    expect((await fixture.readContact()).name).toBe('Atelier Atlas modifié');
    expect(requests.filter(({ path }) => path === '/rpc/res.partner/write')).toHaveLength(1);
    await page.reload();
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).waitFor();
    await openContacts();
    await page.getByText('Atelier Atlas modifié', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await page.getByRole('button', { name: 'Se connecter', exact: true }).waitFor();
    expect(await page.getByText('Atelier Atlas modifié', { exact: true }).count()).toBe(0);
    expect((await context.cookies()).some((entry) => entry.name === '__Host-socle_session')).toBe(
      false,
    );
    await signIn();
    await openContacts();
    await page.getByText('Atelier Atlas modifié', { exact: true }).waitFor();
  });

  it('keeps or discards a draft through the navigation confirmation without writing it', async () => {
    await signIn();
    await openContacts();
    await openAtlas();
    const saved = await fixture.readContact();
    await page.getByRole('button', { name: 'Modifier : Nom', exact: true }).click();
    await page.getByLabel(/^Nom\b/).fill('Brouillon non enregistré');
    await page
      .getByRole('navigation', { name: 'Mes données' })
      .getByRole('button', { name: /^Contacts?$/ })
      .click();
    await page.getByRole('dialog', { name: 'Modifications en cours' }).waitFor();
    await page.getByRole('button', { name: 'Rester sur la fiche', exact: true }).click();
    expect(await page.getByLabel(/^Nom\b/).inputValue()).toBe('Brouillon non enregistré');
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await page.getByRole('button', { name: 'Abandonner les modifications', exact: true }).click();
    await page.getByRole('button', { name: 'Se connecter', exact: true }).waitFor();
    expect(await fixture.readContact()).toEqual(saved);
  });

  it('renders a reader catalogue without edit controls and reconnects after a revoked session', async () => {
    await signIn('reader');
    await openContacts();
    const saved = await fixture.readContact();
    await page
      .getByRole('row')
      .filter({ has: page.getByText(saved.name, { exact: true }) })
      .focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Retour à la liste', exact: true }).waitFor();
    await page.getByText(saved.name, { exact: true }).first().waitFor();
    expect(await page.getByRole('button', { name: /^Modifier :/ }).count()).toBe(0);
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await signIn();
    await openContacts();
    expectedUnauthenticated.add('/rpc/res.partner/searchRead');
    expectedUnauthenticated.add('/rpc/res.partner/searchCount');
    await fixture.revokeManagerSessions();
    await page.getByRole('button', { name: 'Trier par Nom', exact: true }).click();
    await page.getByRole('button', { name: 'Se connecter', exact: true }).waitFor();
    expect(await page.getByText(saved.name, { exact: true }).count()).toBe(0);
    await signIn();
    await openContacts();
    await page.getByText(saved.name, { exact: true }).waitFor();
  });

  it('keeps the mobile Arabic shell usable with accessible preferences and no document overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn();
    await openContacts();
    await page.getByText('Préférences', { exact: true }).click();
    await page.getByLabel('Thème', { exact: true }).selectOption('dark');
    await page.getByLabel('Densité', { exact: true }).selectOption('compact');
    await page.getByLabel('Langue', { exact: true }).selectOption('ar');
    await expect.poll(() => page.locator('html').getAttribute('dir')).toBe('rtl');
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('ar');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    expect(await page.locator('html').getAttribute('data-density')).toBe('compact');
    await page.getByText('التفضيلات', { exact: true }).click();
    await page.getByRole('grid').waitFor();
    await checkAccessibility('contacts-ar-mobile');
    const saved = await fixture.readContact();
    await page
      .getByRole('row')
      .filter({ has: page.getByText(saved.name, { exact: true }) })
      .focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'تعديل: الاسم', exact: true }).waitFor();
    await checkAccessibility('contact-ar-mobile');
    const dimensions = await page.evaluate(() => {
      const html = (
        globalThis as unknown as {
          document: { documentElement: { clientWidth: number; scrollWidth: number } };
        }
      ).document.documentElement;
      return { width: html.clientWidth, content: html.scrollWidth };
    });
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  });
});
