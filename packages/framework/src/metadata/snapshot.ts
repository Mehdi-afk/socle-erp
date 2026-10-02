// SPDX-License-Identifier: LGPL-3.0-only
import { ModelDefinitionError } from '../orm/model.js';
import { ViewError } from '../views/selector.js';
import { checkSnapshotSize, registrySnapshotSchema } from './schema.js';
import type {
  FieldMetadata,
  HydratedRegistrySnapshot,
  ModelMetadata,
  RegistrySnapshot,
} from './types.js';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate bounded JSON, public attributes, uniqueness and all presentation references. @public */
export function parseRegistrySnapshot(value: unknown): RegistrySnapshot {
  checkSnapshotSize(value);
  return freeze(registrySnapshotSchema.parse(value));
}

/** Build lookup-only catalogues; no model methods, constraints or ORM classes are created. @public */
export function hydrateRegistrySnapshot(snapshot: RegistrySnapshot): HydratedRegistrySnapshot {
  const valid = parseRegistrySnapshot(snapshot);
  const models = new Map<string, ModelMetadata>();
  for (const model of valid.models) {
    const fields = new Map<string, FieldMetadata>(
      model.fields.map(({ name, ...field }) => [name, Object.freeze(field)]),
    );
    models.set(
      model.name,
      Object.freeze({
        name: model.name,
        abstract: false,
        description: model.description,
        fields,
        order: model.order,
      }),
    );
  }
  const views = new Map(valid.views.map((view) => [view.id, view]));
  return Object.freeze({
    userId: valid.userId,
    companyId: valid.companyId,
    permissions: new Map(valid.models.map((model) => [model.name, model.permissions])),
    registry: Object.freeze({
      has: (model: string) => models.has(model),
      get: (model: string) => {
        const found = models.get(model);
        if (!found) throw new ModelDefinitionError(`Unknown model "${model}".`);
        return found;
      },
      names: () => [...models.keys()].sort(),
      field: (model: string, field: string) => models.get(model)?.fields.get(field),
    }),
    views: Object.freeze({
      get: (id: string) => {
        const found = views.get(id);
        if (!found) throw new ViewError(`Unknown view "${id}".`);
        return found;
      },
      default: (model: string, type: 'form' | 'list') =>
        [...views.values()]
          .filter((view) => view.model === model && view.type === type)
          .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))[0],
      ids: () => [...views.keys()].sort(),
    }),
  });
}
