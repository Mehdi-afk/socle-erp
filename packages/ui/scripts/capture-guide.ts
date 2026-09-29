// SPDX-License-Identifier: LGPL-3.0-only
//
// Screenshots of the style guide in a real browser, for the visual review of the design:
// `pnpm --filter @socle/ui capture`. One image per theme, language and screen size, in
// `dist/captures/`. Options: `--themes=hybrid,dark`, `--langs=fr,ar`, `--sizes=desktop,mobile`.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = join(import.meta.dirname, '..');
const option = (name: string, fallback: string[]): string[] => {
  const given = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return given ? given.slice(name.length + 3).split(',') : fallback;
};

const themes = option('themes', ['hybrid', 'dark', 'light']);
const languages = option('langs', ['fr', 'ar']);
const sizes: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const wanted = option('sizes', ['desktop', 'mobile']);

const out = join(root, 'dist', 'captures');
mkdirSync(out, { recursive: true });

const server = await createServer({
  configFile: join(root, 'vite.guide.config.ts'),
  logLevel: 'error',
  server: { port: 6007, host: '127.0.0.1', strictPort: false },
});
await server.listen();
const address = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:6007/';

const browser = await chromium.launch();
try {
  for (const size of wanted) {
    const viewport = sizes[size];
    if (!viewport) throw new Error(`Unknown size "${size}".`);
    for (const theme of themes) {
      for (const language of languages) {
        const page = await browser.newPage({ viewport });
        await page.goto(`${address}?theme=${theme}&lang=${language}`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(out, `${theme}-${language}-${size}.png`),
          fullPage: true,
        });
        await page.close();
        process.stdout.write(`captured ${theme}-${language}-${size}\n`);
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
