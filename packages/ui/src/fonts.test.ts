// SPDX-License-Identifier: LGPL-3.0-only
//
// The fonts are self-hosted: no external URL, every file present in its package, only the ranges
// we need, and the families named in the tokens are the ones declared.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scale } from './tokens.js';

const css = readFileSync(join(import.meta.dirname, 'fonts.css'), 'utf8');
const require = createRequire(import.meta.url);

/** `@fontsource-variable/inter/files/x.woff2` → the file inside the installed package. */
function fileOf(specifier: string): string {
  const [scope, name, ...rest] = specifier.split('/');
  const manifest = require.resolve(`${scope ?? ''}/${name ?? ''}/package.json`);
  return join(dirname(manifest), ...rest);
}

const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1] as string);

describe('self-hosted fonts', () => {
  it('load nothing from the network', () => {
    expect(css).not.toMatch(/https?:|\/\//);
    expect(css).not.toContain('@import');
    expect(urls.length).toBe(3);
    for (const url of urls) expect(url.startsWith('@fontsource-variable/'), url).toBe(true);
  });

  it('point at files that exist, in a compact format, of a reasonable weight', () => {
    let total = 0;
    for (const url of urls) {
      const file = fileOf(url);
      expect(existsSync(file), url).toBe(true);
      expect(file.endsWith('.woff2')).toBe(true);
      total += statSync(file).size;
    }
    // Inter latin + latin-ext + Arabic: about 300 KB, downloaded only where the text needs it.
    expect(total).toBeLessThan(350_000);
  });

  it('declare every face with a variable weight, a swap display and a unicode range', () => {
    const faces = css.split('@font-face').slice(1);
    expect(faces).toHaveLength(3);
    for (const face of faces) {
      expect(face).toContain('font-weight: 100 900;');
      expect(face).toContain('font-display: swap;');
      expect(face).toContain('unicode-range:');
      expect(face).toContain("format('woff2-variations')");
    }
    // Latin pages never fetch the Arabic font: its range starts in the Arabic block.
    const arabic = faces.find((face) => face.includes('Noto Sans Arabic Variable')) ?? '';
    expect(arabic).toContain('u+0600-06ff');
    expect(arabic).not.toContain('u+0000-00ff');
  });

  it('use the family names the tokens ask for', () => {
    for (const family of ['Inter Variable', 'Noto Sans Arabic Variable']) {
      expect(css, family).toContain(`font-family: '${family}'`);
      expect(scale.fontSans, family).toContain(family);
    }
    expect(scale.fontArabic.startsWith("'Noto Sans Arabic Variable'")).toBe(true);
  });
});
