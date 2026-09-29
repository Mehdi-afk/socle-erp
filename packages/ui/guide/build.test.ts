// SPDX-License-Identifier: LGPL-3.0-only
// @vitest-environment node
//
// The guide builds with Vite, and what it produces is self-contained: fonts emitted as files next to
// the page, no request to another site, no colour or direction rule slipped into the bundle.
import { join } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** A file the build emits: its name, and its text for a page or a stylesheet. */
interface Emitted {
  readonly fileName: string;
  readonly source?: string | Uint8Array;
}

async function bundle(): Promise<Emitted[]> {
  const result = await build({
    configFile: join(root, 'vite.guide.config.ts'),
    root: join(root, 'guide'),
    logLevel: 'silent',
    build: { write: false, outDir: join(root, 'dist', 'guide-test') },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as { output: Emitted[] }[];
  return outputs.flatMap((entry) => entry.output);
}

describe('guide build', () => {
  it('is self-contained: fonts as files, no external request', async () => {
    const files = await bundle();
    const names = files.map((file) => file.fileName);
    expect(names.some((name) => name.endsWith('.html'))).toBe(true);
    expect(names.filter((name) => name.endsWith('.js')).length).toBeGreaterThanOrEqual(1);
    // The three font files declared in fonts.css.
    const fonts = names.filter((name) => name.endsWith('.woff2'));
    expect(fonts.length).toBe(3);
    expect(fonts.some((name) => name.includes('arabic'))).toBe(true);

    const text = files
      .filter((file) => /\.(html|css)$/.test(file.fileName))
      .map((file) => String(file.source ?? ''))
      .join('\n');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('@import');
    // The tokens and the components are all there.
    expect(text).toContain('--color-accent');
    expect(text).toContain('.ui-button');
    expect(text).toContain('.ui-card');
  }, 120_000);
});
