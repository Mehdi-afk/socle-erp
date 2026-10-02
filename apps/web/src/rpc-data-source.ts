// SPDX-License-Identifier: LGPL-3.0-only
import {
  hydrateRegistrySnapshot,
  parseRegistrySnapshot,
  type ModelCatalog,
  type ModelPermissions,
  type ViewCatalog,
} from '@socle/framework';
import type { DataSource, RecordValues } from '@socle/view-engine/data-source';
import { z } from 'zod';

import { RpcDataError, type RpcErrorCode } from './rpc-errors.js';
import {
  calendarEventSchema,
  notificationSchema,
  threadActivitySchema,
  threadMessageSchema,
  threadPageSchema,
} from './thread-schema.js';

/** Options for an online client bound to the current same-origin session. @public */
export interface WebClientOptions {
  readonly language?: string;
  /** Injectable for tests; the browser implementation always uses same-origin relative URLs. */
  readonly fetch?: typeof globalThis.fetch;
  /** Aborting closes this source, including pending requests. */
  readonly signal?: AbortSignal;
}

/** Options for an online source using metadata already supplied by the application. @public */
export interface RpcDataSourceOptions extends WebClientOptions {
  /** Metadata does not grant any server permissions. */
  readonly registry: ModelCatalog;
}

/** Filtered metadata and data source opened under the same authenticated session. @public */
export interface WebClient {
  readonly registry: ModelCatalog;
  readonly views: ViewCatalog;
  /** Global ACL capabilities only; record rules are still enforced on every server operation. */
  readonly permissions: ReadonlyMap<string, ModelPermissions>;
  readonly userId: string;
  readonly companyId: string | null;
  readonly data: RpcDataSource;
  /** Close the data source; the application must also unmount the associated views. */
  dispose(): void;
}

/**
 * Online-only data source. Recreate it after authentication changes, and unmount the old views.
 * This is not the offline replica: it never queues or automatically retries a mutation.
 * @public
 */
export interface RpcDataSource extends DataSource {
  readonly userId: string;
  write(model: string, id: string, values: Readonly<Record<string, unknown>>): Promise<void>;
  /** Abort requests, discard the in-memory CSRF token and reject any late responses. */
  dispose(): void;
}

const sessionSchema = z.object({
  userId: z.string().min(1).max(254),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
// PostgreSQL returns canonical lowercase UUIDs, including when an input used uppercase.
const recordIdSchema = z.uuid().transform((id) => id.toLowerCase());
const recordsSchema = z.object({
  records: z.array(z.looseObject({ id: recordIdSchema })).max(1000),
});
const countSchema = z.object({ count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const savedSchema = z.object({ ok: z.literal(true) });
const failureSchema = z.object({ error: z.string().max(80) });
const idsSchema = z.array(recordIdSchema);
const fieldsSchema = z.array(z.string().min(1).max(64)).max(200);
const querySchema = z.object({
  domain: z.array(z.unknown()).max(200),
  order: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0).max(1_000_000),
});

const httpCode = (status: number, body: unknown): RpcErrorCode => {
  const failure = failureSchema.safeParse(body);
  if (status === 401) return 'unauthenticated';
  if (status === 403)
    return failure.success && failure.data.error === 'csrf' ? 'csrf' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 409 || status === 422) return 'invalid';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
};

/**
 * Connects the generic views to the existing authenticated RPC routes. The browser owns the
 * HttpOnly cookie; only the CSRF token stays in this closure, never in persistent storage.
 * An expired or rotated session closes the source. There is deliberately no transparent retry:
 * neither an uncertain write nor an old view may be replayed under a different user.
 * @public
 */
export async function connectRpcDataSource(options: RpcDataSourceOptions): Promise<RpcDataSource> {
  return (await openDataSource(options, options.registry)).data;
}

/**
 * Loads the server-filtered catalogue and views before exposing the online data source.
 * The metadata POST and subsequent RPC calls share the CSRF token from one session lookup.
 * No module code or executable ORM classes are reconstructed in the browser.
 * @public
 */
export async function connectWebClient(options: WebClientOptions = {}): Promise<WebClient> {
  const { data, metadata } = await openDataSource(options);
  if (!metadata) {
    data.dispose();
    throw new RpcDataError('invalid_response', options.language ?? 'fr');
  }
  return {
    ...metadata,
    data,
    dispose() {
      data.dispose();
    },
  };
}

async function openDataSource(
  options: WebClientOptions,
  providedRegistry?: ModelCatalog,
): Promise<{
  data: RpcDataSource;
  metadata: ReturnType<typeof hydrateRegistrySnapshot> | undefined;
}> {
  const { language = 'fr' } = options;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let terminal: RpcDataError | undefined;
  let csrf = '';
  const error = (code: RpcErrorCode, status?: number): RpcDataError =>
    new RpcDataError(code, language, status);
  const close = (reason: RpcDataError): void => {
    if (terminal) return;
    terminal = reason;
    csrf = '';
    options.signal?.removeEventListener('abort', dispose);
    controller.abort();
  };
  const dispose = (): void => {
    close(error('disposed'));
  };
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener('abort', dispose, { once: true });

  const active = (): void => {
    if (terminal) throw terminal;
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown, code: RpcErrorCode): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw error(code);
    return result.data;
  };
  const request = async <T>(path: string, schema: z.ZodType<T>, payload?: unknown): Promise<T> => {
    active();
    // Serialize before the first await: a caller cannot mutate a draft already being sent.
    let body: string | undefined;
    try {
      // JSON.stringify alone silently drops undefined and changes NaN/Infinity into null.
      body = payload === undefined ? undefined : JSON.stringify(z.json().parse(payload));
    } catch {
      throw error('invalid');
    }
    let onAbort = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(terminal ?? error('disposed'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const receive = async (): Promise<T> => {
      const response = await fetcher(path, {
        method: body === undefined ? 'GET' : 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-csrf-token': csrf,
              },
        ...(body === undefined ? {} : { body }),
      });
      active();
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        if (response.ok) throw error('invalid_response', response.status);
      }
      active();
      if (!response.ok) {
        const failure = error(httpCode(response.status, result), response.status);
        if (failure.code === 'unauthenticated' || failure.code === 'csrf') close(failure);
        throw failure;
      }
      return parse(schema, result, 'invalid_response');
    };
    try {
      const result = await Promise.race([receive(), aborted]);
      active();
      return result;
    } catch (caught) {
      if (terminal) throw terminal;
      if (caught instanceof RpcDataError) throw caught;
      throw error('unavailable');
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  };

  let session: z.infer<typeof sessionSchema>;
  let registry: ModelCatalog;
  let metadata: ReturnType<typeof hydrateRegistrySnapshot> | undefined;
  try {
    session = await request('/auth/session', sessionSchema);
    active();
    csrf = session.csrfToken;
    if (providedRegistry) {
      registry = providedRegistry;
    } else {
      const response = await request('/web/metadata', z.unknown(), {});
      try {
        const snapshot = parseRegistrySnapshot(response);
        if (snapshot.userId !== session.userId) throw error('invalid_response');
        metadata = hydrateRegistrySnapshot(snapshot);
        registry = metadata.registry;
      } catch {
        throw error('invalid_response');
      }
      active();
    }
  } catch (caught) {
    dispose();
    throw caught;
  }

  const modelOf = (model: string): void => {
    active();
    // Registry membership plus a single route segment; never accept an arbitrary URL or path.
    if (
      !model.split('.').every((segment) => /^[a-z][a-z0-9_]*$/.test(segment)) ||
      !registry.has(model)
    ) {
      throw error('invalid');
    }
    if (registry.get(model).abstract) throw error('invalid');
  };
  const fieldsOf = (model: string, fields: readonly string[]): string[] => {
    const wanted = parse(
      fieldsSchema,
      [...new Set(fields.filter((name) => name !== 'id'))],
      'invalid',
    );
    if (wanted.some((name) => !registry.get(model).fields.has(name))) throw error('invalid');
    return wanted;
  };
  const recordsOf = (
    records: RecordValues[],
    fields: readonly string[],
    wanted?: ReadonlySet<string>,
  ): RecordValues[] => {
    const seen = new Set<string>();
    return records.map((record) => {
      if (seen.has(record.id) || (wanted && !wanted.has(record.id)))
        throw error('invalid_response');
      seen.add(record.id);
      if (fields.some((name) => !Object.hasOwn(record, name))) throw error('invalid_response');
      // Do not leak fields the caller did not request, even if a server accidentally returns them.
      return { ...Object.fromEntries(fields.map((name) => [name, record[name]])), id: record.id };
    });
  };

  const read: RpcDataSource['read'] = async (model, ids, fields) => {
    modelOf(model);
    const wantedFields = fieldsOf(model, fields);
    const wantedIds = [...new Set(parse(idsSchema, ids, 'invalid'))];
    const found = new Map<string, RecordValues>();
    for (let offset = 0; offset < wantedIds.length; offset += 1000) {
      const batch = wantedIds.slice(offset, offset + 1000);
      const response = await request(`/rpc/${model}/read`, recordsSchema, {
        ids: batch,
        fields: wantedFields,
      });
      for (const record of recordsOf(response.records, wantedFields, new Set(batch))) {
        found.set(record.id, record);
      }
    }
    active();
    return wantedIds.flatMap((id) => {
      const record = found.get(id);
      return record ? [record] : [];
    });
  };

  const data: RpcDataSource = {
    thread: {
      async notifications() {
        return (
          await request(
            '/mail/notifications/read',
            z.object({ notifications: z.array(notificationSchema).max(100) }),
            {},
          )
        ).notifications;
      },
      async seen(id) {
        const notification = parse(recordIdSchema, id, 'invalid');
        await request(`/mail/notifications/${notification}/seen`, savedSchema, {});
      },
      async activities() {
        return (
          await request(
            '/mail/activities',
            z.object({ activities: z.array(calendarEventSchema).max(500) }),
            {},
          )
        ).activities;
      },
      async read(model, id, before) {
        modelOf(model);
        const recordId = parse(recordIdSchema, id, 'invalid');
        const page =
          before === undefined ? {} : { before: parse(recordIdSchema, before, 'invalid') };
        return request(`/mail/${model}/${recordId}/read`, threadPageSchema, page);
      },
      async post(model, id, body, kind) {
        modelOf(model);
        const recordId = parse(recordIdSchema, id, 'invalid');
        const value = parse(
          z.strictObject({
            body: z.string().trim().min(1).max(10_000),
            kind: z.enum(['comment', 'note']),
          }),
          { body, kind },
          'invalid',
        );
        await request(
          `/mail/${model}/${recordId}/messages`,
          z.object({ message: threadMessageSchema }),
          value,
        );
      },
      async follow(model, id, following) {
        modelOf(model);
        const recordId = parse(recordIdSchema, id, 'invalid');
        await request(`/mail/${model}/${recordId}/follow`, savedSchema, {
          following: parse(z.boolean(), following, 'invalid'),
        });
      },
      async schedule(model, id, activity) {
        modelOf(model);
        const recordId = parse(recordIdSchema, id, 'invalid');
        const value = parse(
          z.strictObject({
            summary: z.string().trim().min(1).max(254),
            typeId: recordIdSchema,
            dueDate: z.iso.date(),
          }),
          activity,
          'invalid',
        );
        await request(
          `/mail/${model}/${recordId}/activities`,
          z.object({ activity: threadActivitySchema }),
          value,
        );
      },
      async finish(model, id, activityId, state, feedback) {
        modelOf(model);
        const recordId = parse(recordIdSchema, id, 'invalid');
        const activity = parse(recordIdSchema, activityId, 'invalid');
        const value = parse(
          z.strictObject({
            state: z.enum(['done', 'cancelled']),
            feedback: z.string().trim().max(10_000),
          }),
          { state, feedback },
          'invalid',
        );
        await request(`/mail/${model}/${recordId}/activities/${activity}`, savedSchema, value);
      },
    },
    userId: session.userId,
    dispose,
    read,
    async search(model, options) {
      modelOf(model);
      const fields = fieldsOf(model, options.fields);
      const query = parse(
        querySchema,
        {
          domain: options.domain ?? [],
          limit: options.limit,
          offset: options.offset,
          ...(options.order === undefined ? {} : { order: options.order }),
        },
        'invalid',
      );
      const [page, total] = await Promise.all([
        request(`/rpc/${model}/searchRead`, recordsSchema, { ...query, fields }),
        request(`/rpc/${model}/searchCount`, countSchema, { domain: query.domain }),
      ]);
      active();
      if (page.records.length > query.limit) throw error('invalid_response');
      return { records: recordsOf(page.records, fields), total: total.count };
    },
    async displayNames(model, ids) {
      modelOf(model);
      const wanted = [...new Set(parse(idsSchema, ids, 'invalid'))];
      const fields = registry.get(model).fields;
      const name = ['name', 'code'].find((candidate) => {
        const field = fields.get(candidate);
        return (
          field &&
          (field.type === 'char' || field.type === 'text') &&
          !field.sensitive &&
          !('groups' in field && Array.isArray(field.groups) && field.groups.length > 0)
        );
      });
      if (!name) return new Map(wanted.map((id) => [id, id]));
      const records = await read(model, wanted, [name]);
      active();
      return new Map(
        records.map((record) => {
          const value = record[name];
          if (value !== null && typeof value !== 'string') throw error('invalid_response');
          return [record.id, typeof value === 'string' && value.trim() ? value : record.id];
        }),
      );
    },
    async write(model, id, values) {
      modelOf(model);
      const recordId = parse(recordIdSchema, id, 'invalid');
      fieldsOf(model, Object.keys(values));
      if (Object.hasOwn(values, 'id')) throw error('invalid');
      await request(`/rpc/${model}/write`, savedSchema, { ids: [recordId], values });
      active();
    },
  };
  return { data, metadata };
}
