// SPDX-License-Identifier: LGPL-3.0-only
import semver from 'semver';
import { z } from 'zod';

import { InvalidManifestError } from './errors.js';

/** Technical name of a module: lowercase snake_case, e.g. `sale`, `l10n_fr`, `pro_fleet`. */
const MODULE_NAME = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;

const HOST_LABEL_CHARS = /^[a-z0-9-]+$/;
const TOP_LEVEL_DOMAIN = /^[a-z]{2,63}$/;

function isHostLabel(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    HOST_LABEL_CHARS.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  );
}

/**
 * A lowercase DNS hostname, without scheme, port, path or wildcard.
 * Checked label by label (no nested quantifiers, hence no catastrophic backtracking).
 */
function isHostname(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split('.');
  const tld = labels.pop();
  return (
    labels.length > 0 &&
    tld !== undefined &&
    TOP_LEVEL_DOMAIN.test(tld) &&
    labels.every(isHostLabel)
  );
}

const moduleName = z.string().regex(MODULE_NAME, 'must be lowercase snake_case (2-64 chars)');

const localizedText = z.strictObject({
  fr: z.string().min(1),
  en: z.string().min(1).optional(),
  ar: z.string().min(1).optional(),
});

const capability = z.union([
  z.literal('sudo'),
  z.literal('cron'),
  z.literal('files'),
  z.strictObject({
    network: z
      .array(
        z.string().refine(isHostname, 'must be a lowercase hostname (no scheme, port or wildcard)'),
      )
      .min(1),
  }),
]);

const manifestSchema = z
  .strictObject({
    name: moduleName,
    version: z.string().refine((v) => semver.valid(v) === v, 'must be a valid SemVer version'),
    label: localizedText,
    category: z.string().min(1).optional(),
    depends: z.array(moduleName).default([]),
    license: z.string().regex(/^[A-Za-z0-9.+-]+$/, 'must be an SPDX identifier or LicenseRef-*'),
    edition: z.enum(['community', 'pro']),
    application: z.boolean().default(false),
    autoInstall: z.boolean().default(false),
    offline: z.strictObject({ syncable: z.boolean() }).default({ syncable: true }),
    engines: z.strictObject({
      socle: z
        .string()
        .refine((r) => semver.validRange(r) !== null, 'must be a valid SemVer range'),
    }),
    capabilities: z.array(capability).default([]),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.depends.includes(manifest.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['depends'],
        message: 'a module cannot depend on itself',
      });
    }
    if (new Set(manifest.depends).size !== manifest.depends.length) {
      ctx.addIssue({ code: 'custom', path: ['depends'], message: 'duplicate dependency' });
    }
  });

/**
 * A capability a module needs at runtime, shown to the administrator before installation
 * and enforced at runtime (ARCHITECTURE.md §11 bis).
 * @public
 */
export type Capability = 'sudo' | 'cron' | 'files' | { readonly network: readonly string[] };

/**
 * A text translated into the supported languages; French is mandatory.
 * @public
 */
export interface LocalizedText {
  readonly fr: string;
  readonly en?: string | undefined;
  readonly ar?: string | undefined;
}

/**
 * Module edition: community modules are LGPL, pro modules are proprietary.
 * @public
 */
export type ModuleEdition = 'community' | 'pro';

/**
 * What a module author writes in `manifest.ts`. Omitted optional fields get their default.
 * @public
 */
export interface ManifestInput {
  /** Technical name, lowercase snake_case; must equal the module directory name. */
  readonly name: string;
  /** SemVer version of the module. */
  readonly version: string;
  readonly label: LocalizedText;
  readonly category?: string | undefined;
  /** Modules this one depends on. Default: none. */
  readonly depends?: readonly string[] | undefined;
  /** SPDX identifier (e.g. `LGPL-3.0-only`) or `LicenseRef-*`. */
  readonly license: string;
  readonly edition: ModuleEdition;
  /** Shown in the application switcher. Default: `false`. */
  readonly application?: boolean | undefined;
  /** Installed automatically once all dependencies are installed ("bridge" module). Default: `false`. */
  readonly autoInstall?: boolean | undefined;
  /** Whether its models are synchronised offline by default. Default: `{ syncable: true }`. */
  readonly offline?: { readonly syncable: boolean } | undefined;
  /** Supported core versions, as a SemVer range (e.g. `^1.2`). */
  readonly engines: { readonly socle: string };
  /** Runtime capabilities. Default: none. */
  readonly capabilities?: readonly Capability[] | undefined;
}

/**
 * A validated, normalized and deeply frozen module manifest.
 * @public
 */
export interface ModuleManifest {
  readonly name: string;
  readonly version: string;
  readonly label: LocalizedText;
  readonly category?: string | undefined;
  readonly depends: readonly string[];
  readonly license: string;
  readonly edition: ModuleEdition;
  readonly application: boolean;
  readonly autoInstall: boolean;
  readonly offline: { readonly syncable: boolean };
  readonly engines: { readonly socle: string };
  readonly capabilities: readonly Capability[];
}

// Compile-time guarantee that the public types and the validation schema stay in sync.
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _ManifestOutputMatches = Assert<
  z.output<typeof manifestSchema> extends ModuleManifest ? true : false
>;
export type _ManifestInputMatches = Assert<
  Equals<keyof z.input<typeof manifestSchema>, keyof ManifestInput>
>;
export type _CapabilityMatches = Assert<
  z.output<typeof capability> extends Capability ? true : false
>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Declares a module manifest. Validates it strictly (unknown keys are rejected),
 * applies defaults and returns a deeply frozen object.
 * @throws {@link InvalidManifestError} when the manifest is invalid.
 * @public
 */
export function defineManifest(input: ManifestInput): ModuleManifest {
  return parseManifest(input);
}

/**
 * Validates an untrusted value as a manifest (e.g. loaded from a module package).
 * @throws {@link InvalidManifestError} when the value is not a valid manifest.
 * @public
 */
export function parseManifest(value: unknown): ModuleManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const hint =
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      typeof value.name === 'string'
        ? value.name
        : '(unnamed)';
    throw new InvalidManifestError(hint, formatIssues(result.error));
  }
  return deepFreeze(result.data);
}
