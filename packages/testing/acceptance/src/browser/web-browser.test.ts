// SPDX-License-Identifier: LGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axe from 'axe-core';
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createWebBrowserFixture, type WebBrowserFixture } from './fixture.js';

let fixture: WebBrowserFixture;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let evidence: string;
let errors: string[];
let expectedUnauthenticated: Set<string>;
let screenCounter = 0;
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
    await page.screenshot({
      path: join(evidence, `after-${String(++screenCounter)}.png`),
      fullPage: true,
    });
    expect(await page.locator('vite-error-overlay').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

async function signIn(role: 'manager' | 'reader' | 'colleague' = 'manager'): Promise<void> {
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
  await page.locator('.ve-form .ui-card').first().waitFor();
}

async function checkAccessibility(name: string, target?: Locator): Promise<void> {
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
  if (target) await target.screenshot({ path: join(evidence, `${name}.png`) });
  else await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  expect(violations).toEqual([]);
}

describe('web client with real PostgreSQL and browser cookies', () => {
  it('posts text, schedules a personal deadline, opens its calendar and records completion in PostgreSQL', async () => {
    await signIn();
    await openContacts();
    await openAtlas();
    await page.getByLabel('Message', { exact: true }).waitFor();
    const text = '<img src=x onerror=alert(1)> Message de validation';
    await page.getByLabel('Message', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await page.getByText(text, { exact: true }).waitFor();
    expect(await page.locator('.ve-thread-message img').count()).toBe(0);
    await page.getByLabel('Type de message', { exact: true }).selectOption('note');
    await page.getByLabel('Note interne', { exact: true }).fill('Note interne de validation');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await page.getByText('Note interne de validation', { exact: true }).waitFor();
    const form = page.getByRole('form', { name: 'Planifier une activité' });
    await form.getByLabel(/^Objet\b/).fill('Appel de validation');
    await form.getByLabel(/^Type d’activité/).selectOption({ label: 'Appel' });
    await form.getByLabel(/^Échéance/).fill('2026-10-02');
    await form.getByRole('button', { name: 'Planifier pour moi' }).click();
    await page.getByText('Appel de validation', { exact: true }).waitFor();
    await checkAccessibility('mail-contact-fr');
    await page.getByRole('button', { name: 'Mes activités', exact: true }).click();
    const calendar = page.getByRole('dialog', { name: 'Mes activités', exact: true });
    await calendar.getByLabel('Date du calendrier').fill('2026-10-02');
    await calendar.getByRole('button', { name: /Appel de validation/ }).waitFor();
    await checkAccessibility('mail-calendar-fr', calendar);
    await calendar.getByLabel('Période', { exact: true }).selectOption('month');
    expect(await calendar.locator('.ve-calendar-day').count()).toBe(42);
    await calendar.getByLabel('Type d’activité', { exact: true }).selectOption('call');
    await calendar.getByRole('button', { name: /Appel de validation/ }).scrollIntoViewIfNeeded();
    await checkAccessibility('mail-calendar-month-fr', calendar);
    await calendar.getByRole('button', { name: /Appel de validation/ }).click();
    await calendar.waitFor({ state: 'hidden' });
    await page.getByLabel('Compte rendu', { exact: true }).fill('Contacté pendant le test');
    await page.getByRole('button', { name: 'Terminer', exact: true }).click();
    await page.locator('.ve-thread-text').filter({ hasText: 'Contacté pendant le test' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).waitFor();
    await openContacts();
    await openAtlas();
    await page.getByText(text, { exact: true }).waitFor();
    await page.locator('.ve-thread-text').filter({ hasText: 'Contacté pendant le test' }).waitFor();
    expect(await page.getByRole('button', { name: 'Terminer', exact: true }).count()).toBe(0);
  });

  it('denies reader writes, direct mail RPCs, foreign-company access and missing CSRF', async () => {
    await signIn();
    await openContacts();
    await openAtlas();
    await page.getByLabel('Type de message', { exact: true }).selectOption('note');
    await page.getByLabel('Note interne', { exact: true }).fill('Note réservée au test lecteur');
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await page.getByText('Note réservée au test lecteur', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await signIn('reader');
    await openContacts();
    await openAtlas();
    await page.getByRole('heading', { name: 'Échanges', exact: true }).waitFor();
    expect(await page.getByText('Note réservée au test lecteur', { exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Publier', exact: true }).count()).toBe(0);
    const session = (await (await context.request.get(`${fixture.url}/auth/session`)).json()) as {
      csrfToken: string;
    };
    const headers = { Origin: fixture.url, 'x-csrf-token': session.csrfToken };
    const refused = await context.request.post(
      `${fixture.url}/mail/res.partner/${fixture.contactId}/messages`,
      { headers, data: { body: 'Denied', kind: 'comment' } },
    );
    expect(refused.status()).toBe(403);
    const foreign = await context.request.post(
      `${fixture.url}/mail/res.partner/${fixture.foreignContactId}/read`,
      { headers, data: {} },
    );
    expect(foreign.status()).toBe(404);
    const direct = await context.request.post(`${fixture.url}/rpc/mail.message/searchRead`, {
      headers,
      data: { domain: [], fields: ['body'], limit: 10, offset: 0 },
    });
    expect(direct.status()).toBe(403);
    const csrf = await context.request.post(
      `${fixture.url}/mail/res.partner/${fixture.contactId}/messages`,
      { headers: { Origin: fixture.url }, data: { body: 'Denied', kind: 'comment' } },
    );
    expect(csrf.status()).toBe(403);
  });

  it('notifies a subscriber and commits concurrent completion only once', async () => {
    await signIn('colleague');
    await openContacts();
    await openAtlas();
    await page.getByRole('button', { name: 'Suivre la fiche', exact: true }).click();
    await page.getByRole('button', { name: 'Ne plus suivre', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await signIn();
    const session = (await (await context.request.get(`${fixture.url}/auth/session`)).json()) as {
      csrfToken: string;
    };
    const headers = { Origin: fixture.url, 'x-csrf-token': session.csrfToken };
    const root = `${fixture.url}/mail/res.partner/${fixture.contactId}`;
    const thread = await context.request.post(`${root}/read`, { headers, data: {} });
    const { types } = (await thread.json()) as { types: { id: string }[] };
    const typeId = types[0]?.id;
    if (!typeId) throw new Error('Missing activity type.');
    const scheduled = await context.request.post(`${root}/activities`, {
      headers,
      data: { summary: 'Concurrent completion', typeId, dueDate: '2026-10-02' },
    });
    expect(scheduled.status()).toBe(200);
    const { activity } = (await scheduled.json()) as { activity: { id: string } };
    const finish = () =>
      context.request.post(`${root}/activities/${activity.id}`, {
        headers,
        data: { state: 'done', feedback: 'Completed exactly once' },
      });
    const responses = await Promise.all([finish(), finish()]);
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 404]);
    const result = await context.request.post(`${root}/read`, { headers, data: {} });
    const { messages } = (await result.json()) as { messages: { body: string }[] };
    expect(
      messages.filter((message) => message.body.includes('Completed exactly once')),
    ).toHaveLength(1);
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await signIn('colleague');
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true });
    const entry = inbox.getByRole('button', { name: /Nouvel échange/ });
    await entry.first().waitFor();
    await checkAccessibility('mail-notifications-fr', inbox);
    await entry.first().click();
    await inbox.waitFor({ state: 'hidden' });
    await page.locator('.ve-thread-text').filter({ hasText: 'Completed exactly once' }).waitFor();
    const own = (await (await context.request.get(`${fixture.url}/auth/session`)).json()) as {
      csrfToken: string;
    };
    await expect
      .poll(async () => {
        const response = await context.request.post(`${fixture.url}/mail/notifications/read`, {
          headers: { Origin: fixture.url, 'x-csrf-token': own.csrfToken },
          data: {},
        });
        const value = (await response.json()) as { notifications: unknown[] };
        return value.notifications.length;
      })
      .toBe(0);
  });

  it('keeps a message draft through navigation and displays the calendar in Arabic on mobile', async () => {
    await signIn();
    await openContacts();
    await openAtlas();
    await page.getByLabel('Message', { exact: true }).fill('Brouillon de message');
    await page
      .getByRole('navigation', { name: 'Mes données' })
      .getByRole('button', { name: /^Contacts?$/ })
      .click();
    await page.getByRole('dialog', { name: 'Modifications en cours' }).waitFor();
    await page.getByRole('button', { name: 'Rester sur la fiche', exact: true }).click();
    expect(await page.getByLabel('Message', { exact: true }).inputValue()).toBe(
      'Brouillon de message',
    );
    await page.getByLabel('Message', { exact: true }).fill('');
    const form = page.getByRole('form', { name: 'Planifier une activité' });
    await form.getByLabel(/^Objet\b/).fill('موعد تجريبي');
    await form.getByLabel(/^Type d’activité/).selectOption({ label: 'Réunion' });
    await form.getByLabel(/^Échéance/).fill('2026-10-02');
    await form.getByRole('button', { name: 'Planifier pour moi' }).click();
    await page.getByText('موعد تجريبي', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('Préférences', { exact: true }).click();
    await page.getByLabel('Langue', { exact: true }).selectOption('ar');
    await page.getByText('التفضيلات', { exact: true }).click();
    await checkAccessibility('mail-contact-ar-mobile');
    await page.getByRole('button', { name: 'أنشطتي', exact: true }).click();
    const calendar = page.getByRole('dialog', { name: 'أنشطتي', exact: true });
    await calendar.getByLabel('التاريخ', { exact: true }).fill('2026-10-02');
    await calendar.getByRole('button', { name: /موعد تجريبي/ }).waitFor();
    await calendar.getByRole('button', { name: /موعد تجريبي/ }).scrollIntoViewIfNeeded();
    await checkAccessibility('mail-calendar-ar-mobile', calendar);
    expect(
      await page.evaluate(() => {
        const html = (
          globalThis as unknown as {
            document: { documentElement: { clientWidth: number; scrollWidth: number } };
          }
        ).document.documentElement;
        return html.scrollWidth <= html.clientWidth;
      }),
    ).toBe(true);
  });
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
  it('edits a list row, protects its draft and persists its value in French and mobile Arabic', async () => {
    await signIn();
    await openContacts();
    expect(new URL(page.url()).origin).toBe(fixture.url);
    await expect.poll(() => page.title()).toBe('Contact — Socle ERP');
    const saved = await fixture.readContact();
    const row = page.getByRole('row').filter({ has: page.getByText(saved.name, { exact: true }) });
    await row.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Modifier la ligne', exact: true }).click();
    await page.getByLabel('Nom', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'obligatoire' }).waitFor();
    await page.getByLabel('Nom', { exact: true }).fill('Atlas édition en liste');
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
    await page.getByRole('dialog', { name: 'Modifications en cours' }).waitFor();
    await page.getByRole('button', { name: 'Rester sur la fiche', exact: true }).click();
    expect(await page.getByLabel('Nom', { exact: true }).inputValue()).toBe(
      'Atlas édition en liste',
    );
    expect(
      await page.getByRole('button', { name: 'Trier par Nom', exact: true }).isDisabled(),
    ).toBe(true);
    await checkAccessibility('list-edit-fr');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await page.getByText('Atlas édition en liste', { exact: true }).waitFor();
    expect((await fixture.readContact()).name).toBe('Atlas édition en liste');
    await page.reload();
    await page.getByRole('button', { name: 'Se déconnecter', exact: true }).waitFor();
    await openContacts();
    await page.getByText('Atlas édition en liste', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('Préférences', { exact: true }).click();
    await page.getByLabel('Densité', { exact: true }).selectOption('compact');
    await page.getByLabel('Langue', { exact: true }).selectOption('ar');
    await page.getByText('التفضيلات', { exact: true }).click();
    const arabicRow = page
      .getByRole('row')
      .filter({ has: page.getByText('Atlas édition en liste', { exact: true }) });
    await arabicRow.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'تعديل السطر', exact: true }).click();
    await page.getByLabel('الاسم', { exact: true }).fill('أطلس — تعديل السطر');
    await checkAccessibility('list-edit-ar-mobile');
    await expect.poll(() => page.locator('html').getAttribute('dir')).toBe('rtl');
    expect(
      await page.evaluate(() => {
        const html = (
          globalThis as unknown as {
            document: { documentElement: { clientWidth: number; scrollWidth: number } };
          }
        ).document.documentElement;
        return html.scrollWidth <= html.clientWidth;
      }),
    ).toBe(true);
    await page.getByRole('button', { name: 'حفظ', exact: true }).click();
    await page.getByText('أطلس — تعديل السطر', { exact: true }).waitFor();
    expect((await fixture.readContact()).name).toBe('أطلس — تعديل السطر');
    await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
    await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Se connecter', exact: true }).waitFor();
    await signIn('reader');
    await openContacts();
    const readerRow = page
      .getByRole('row')
      .filter({ has: page.getByText('أطلس — تعديل السطر', { exact: true }) });
    await readerRow.getByRole('checkbox').check();
    expect(await page.getByRole('button', { name: 'Modifier la ligne', exact: true }).count()).toBe(
      0,
    );
  });
});
