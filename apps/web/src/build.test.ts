// SPDX-License-Identifier: LGPL-3.0-only
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { build, createLogger } from 'vite';
import { expect, it } from 'vitest';
import { z } from 'zod';

const webRoot = resolve(import.meta.dirname, '..');
const prefix = 'socle-web-build-';
const manifestSchema = z.record(
  z.string(),
  z.object({
    file: z.string(),
    src: z.string().optional(),
    isEntry: z.boolean().optional(),
    isDynamicEntry: z.boolean().optional(),
    imports: z.array(z.string()).optional(),
    dynamicImports: z.array(z.string()).optional(),
    css: z.array(z.string()).optional(),
  }),
);

/** Generated asset paths must stay within this build's private output directory. */
function assetPath(output: string, name: string): string {
  const path = resolve(output, name);
  const fromOutput = relative(output, path);
  if (
    fromOutput === '' ||
    isAbsolute(fromOutput) ||
    fromOutput === '..' ||
    fromOutput.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
    throw new Error('Build asset escaped the temporary output directory.');
  return path;
}

async function removeTemporaryBuild(directory: string, temporaryRoot: string): Promise<void> {
  // Resolve and confine the final target before every recursive removal, including on Windows.
  const target = await realpath(directory);
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith(prefix))
    throw new Error('Refusing to remove an unexpected temporary build directory.');
  await rm(target, { recursive: true, force: true });
}

it('keeps initial production JS and CSS below 300 KiB gzip with a separate workspace chunk', async () => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, prefix));
  const output = join(directory, 'output');
  try {
    const warnings: string[] = [];
    await build({
      configFile: join(webRoot, 'vite.config.ts'),
      root: webRoot,
      envDir: false,
      // Vitest sets NODE_ENV=test; measure the browser's production code without mutating it.
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      logLevel: 'silent',
      customLogger: {
        ...createLogger('silent'),
        warn(message) {
          warnings.push(message);
        },
        warnOnce(message) {
          warnings.push(message);
        },
      },
      build: { write: true, outDir: output, emptyOutDir: false, manifest: true },
    });
    // Vite's default 500 kB raw-size advisory differs from our measured initial gzip budget.
    // Every other warning, including Node dependencies externalized for the browser, fails.
    expect(
      warnings.filter(
        (message) => !message.includes('Some chunks are larger than 500 kB after minification.'),
      ),
    ).toEqual([]);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(output, '.vite', 'manifest.json'), 'utf8')),
    );
    const html = await readFile(join(output, 'index.html'), 'utf8');
    const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error('No production HTML entry was emitted.');
    expect(html).toContain(`/${entry[1].file}`);

    const initial = new Set<string>();
    const visit = (key: string): void => {
      if (initial.has(key)) return;
      const chunk = manifest[key];
      if (!chunk) throw new Error('A static import is missing from the production manifest.');
      initial.add(key);
      for (const dependency of chunk.imports ?? []) visit(dependency);
    };
    visit(entry[0]);
    const workspace = Object.entries(manifest).find(
      ([, chunk]) => chunk.src === 'src/workspace.tsx',
    );
    expect(workspace).toBeDefined();
    if (!workspace) throw new Error('No separate workspace chunk was emitted.');
    expect(workspace[1].isDynamicEntry).toBe(true);
    expect(initial.has(workspace[0])).toBe(false);
    const dynamic = [...initial].flatMap((key) => manifest[key]?.dynamicImports ?? []);
    expect(dynamic).toContain(workspace[0]);
    expect(html).not.toContain(workspace[1].file);

    const assets = new Set<string>();
    for (const key of initial) {
      const chunk = manifest[key];
      if (!chunk) throw new Error('Missing initial chunk.');
      assets.add(chunk.file);
      for (const css of chunk.css ?? []) assets.add(css);
    }
    // Count any JS/CSS referenced directly by the generated HTML as well as the manifest graph.
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
      const name = match[1];
      if (name && /\.(?:js|css)$/.test(name)) assets.add(name.replace(/^\//, ''));
    }
    const initialFiles = [...assets].filter((name) => /\.(?:js|css)$/.test(name));
    expect(initialFiles.some((name) => name.endsWith('.js'))).toBe(true);
    expect(initialFiles.some((name) => name.endsWith('.css'))).toBe(true);
    let jsBytes = 0;
    let cssBytes = 0;
    for (const name of initialFiles) {
      const bytes = gzipSync(await readFile(assetPath(output, name))).byteLength;
      if (name.endsWith('.js')) jsBytes += bytes;
      else cssBytes += bytes;
    }
    const total = jsBytes + cssBytes;
    const measurement = `Initial web bundle: ${String(jsBytes)} B JS + ${String(cssBytes)} B CSS = ${String(total)} B gzip (fonts excluded).`;
    console.info(measurement);
    expect(total, measurement).toBeLessThanOrEqual(300 * 1024);

    for (const chunk of Object.values(manifest)) {
      if (!chunk.file.endsWith('.js')) continue;
      const javascript = await readFile(assetPath(output, chunk.file), 'utf8');
      expect(javascript).not.toContain('__vite-browser-external');
    }
  } finally {
    await removeTemporaryBuild(directory, temporaryRoot);
  }
}, 120_000);
