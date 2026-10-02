// SPDX-License-Identifier: LGPL-3.0-only
import { isStoredColumn, type FieldDefinition } from '../orm/fields.js';
import type { OrderTerm } from '../orm/model-registry.js';
import type { LocalizedText } from '../registry/manifest.js';
import type { ViewNode } from '../views/nodes.js';

/** Presentation data shared by an ORM registry and a filtered client catalogue. @public */
export interface FieldMetadata extends Pick<
  FieldDefinition,
  | 'type'
  | 'label'
  | 'help'
  | 'required'
  | 'readonly'
  | 'size'
  | 'selection'
  | 'comodel'
  | 'inverse'
  | 'digits'
  | 'currencyField'
  | 'sensitive'
> {
  /** Explicit in snapshots; omitted by existing ORM field definitions. */
  readonly stored?: boolean;
}

/** Whether sorting can use the field's own stored column. @public */
export function isStoredMetadata(field: FieldMetadata): boolean {
  return field.stored ?? isStoredColumn(field);
}

/** A description for rendering, with no executable model class. @public */
export interface ModelMetadata {
  readonly name: string;
  readonly abstract: boolean;
  readonly description?: LocalizedText | undefined;
  readonly fields: ReadonlyMap<string, FieldMetadata>;
  readonly order: readonly OrderTerm[];
}

/** Metadata lookup; a complete ModelRegistry is also a ModelCatalog. @public */
export interface ModelCatalog {
  has(model: string): boolean;
  get(model: string): ModelMetadata;
  names(): readonly string[];
  field(model: string, field: string): FieldMetadata | undefined;
}

/** Global ACL capabilities, never an authorization for a particular record. @public */
export interface ModelPermissions {
  readonly create: boolean;
  readonly write: boolean;
  readonly unlink: boolean;
}

/** Serializable field metadata; computation and relation paths are deliberately absent. @public */
export interface FieldSnapshot extends FieldMetadata {
  readonly name: string;
  readonly stored: boolean;
  readonly readonly: boolean;
}

/** A concrete model the current user can read. @public */
export interface ModelSnapshot {
  readonly name: string;
  readonly description?: LocalizedText | undefined;
  readonly permissions: ModelPermissions;
  readonly fields: readonly FieldSnapshot[];
  readonly order: readonly OrderTerm[];
}

/** A composed and filtered view, without module code or inheritance instructions. @public */
export interface ViewSnapshot {
  readonly id: string;
  readonly model: string;
  readonly type: 'form' | 'list';
  readonly priority: number;
  readonly arch: ViewNode;
}

/** Versioned metadata for one authenticated user and company context. @public */
export interface RegistrySnapshot {
  readonly version: 1;
  readonly userId: string;
  readonly companyId: string | null;
  readonly models: readonly ModelSnapshot[];
  readonly views: readonly ViewSnapshot[];
}

/** Filtered views, without an executable ORM registry. @public */
export interface ViewCatalog {
  get(id: string): ViewSnapshot;
  default(model: string, type: 'form' | 'list'): ViewSnapshot | undefined;
  ids(): readonly string[];
}

/** The in-memory presentation catalogues of a validated snapshot. @public */
export interface HydratedRegistrySnapshot {
  readonly registry: ModelCatalog;
  readonly views: ViewCatalog;
  readonly permissions: ReadonlyMap<string, ModelPermissions>;
  readonly userId: string;
  readonly companyId: string | null;
}
