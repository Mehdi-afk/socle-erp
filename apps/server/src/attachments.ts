// SPDX-License-Identifier: LGPL-3.0-only
//
// Attachment endpoints (lot 2.1 `ir.attachment`, ARCHITECTURE.md §9.3 "Fichiers"):
// - POST /attachments/:model/:id   raw body, header `x-file-name`: needs the right to change
//   the target record; the name is sanitised, the type detected from the content, the file
//   stored in S3 and marked "pending" until the antivirus has scanned it;
// - GET  /attachments/:model/:id   the attachments of a record the user may read;
// - GET  /attachments/:id/content  the file, only once the antivirus found it clean.
import { createHash, randomUUID } from 'node:crypto';

import type { Environment, UserContext } from '@socle/framework';
import {
  contentDisposition,
  detectFileType,
  sanitizeFileName,
  type S3Client,
} from '@socle/runtime';
import type { RunInTransaction } from '@socle/sync';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { HttpError } from './http-error.js';
import type { TenantRuntime } from './tenants.js';

const ATTACHMENT = 'ir.attachment';
/** Types a browser may show inline without risk; everything else is sent as a download. */
const SAFE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

const target = z.object({ model: z.string().max(128), id: z.uuid() });
const attachmentId = z.object({ id: z.uuid() });

export interface AttachmentOptions {
  readonly s3: S3Client;
  /** Maximum size of one file (default 25 MiB). */
  readonly maxBytes?: number | undefined;
}

interface Deps {
  readonly tenantOf: (request: FastifyRequest) => TenantRuntime;
  readonly userOf: (request: FastifyRequest) => Promise<UserContext>;
  readonly runner: (
    tenant: TenantRuntime,
    user: UserContext,
    request: FastifyRequest,
  ) => RunInTransaction;
}

interface AttachmentRow {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string | null;
  readonly size: number | null;
  readonly scanStatus: string;
  readonly createdAt: string | null;
}

/** The target record, if the user may see it (and change it when `write`). */
async function checkTarget(
  env: Environment,
  model: string,
  id: string,
  write: boolean,
): Promise<void> {
  if (!env.registry.has(model) || env.registry.get(model).abstract || model === ATTACHMENT)
    throw new HttpError(404, 'not_found', 'Unknown record.');
  const records = await env.model(model).search([['id', '=', id]]);
  if (records.length !== 1) throw new HttpError(404, 'not_found', 'Unknown record.');
  // Checks the right to change it (ACL and record rules) and holds it until commit.
  if (write) await records.lockForUpdate();
}

const PUBLIC_FIELDS = ['name', 'mimetype', 'size', 'scanStatus', 'createdAt'] as const;

export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: Deps,
  options: AttachmentOptions,
): void {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: maxBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const available = (tenant: TenantRuntime): void => {
    if (!tenant.registry.has(ATTACHMENT))
      throw new HttpError(404, 'not_found', 'Attachments are not available (module base).');
  };

  app.post<{ Params: { model: string; id: string } }>(
    '/attachments/:model/:id',
    async (request) => {
      const tenant = deps.tenantOf(request);
      available(tenant);
      const { model, id } = target.parse(request.params);
      const body = request.body;
      if (!(body instanceof Buffer) || body.byteLength === 0)
        throw new HttpError(400, 'invalid_request', 'Send the file as application/octet-stream.');
      const rawName = z
        .string()
        .max(1024)
        .parse(request.headers['x-file-name'] ?? '');
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawName);
      } catch {
        throw new HttpError(400, 'invalid_request', 'Invalid x-file-name header.');
      }
      const user = await deps.userOf(request);
      const data = new Uint8Array(body);
      const name = sanitizeFileName(decoded);
      const now = new Date();
      const storeKey = `${tenant.name}/attachments/${String(now.getUTCFullYear())}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;

      return deps.runner(
        tenant,
        user,
        request,
      )(async ({ env }) => {
        await checkTarget(env, model, id, true);
        await options.s3.put(storeKey, data, 'application/octet-stream');
        const created = await env
          .sudo(`attachment upload on ${model}`)
          .model(ATTACHMENT)
          .create({
            name,
            resModel: model,
            resId: id,
            mimetype: detectFileType(data, name),
            size: data.byteLength,
            checksum: createHash('sha256').update(data).digest('hex'),
            storeKey,
            companyId: env.companyId,
          });
        const [row] = await created.read(['id', ...PUBLIC_FIELDS]);
        return row;
      });
    },
  );

  app.get<{ Params: { model: string; id: string } }>('/attachments/:model/:id', async (request) => {
    const tenant = deps.tenantOf(request);
    available(tenant);
    const { model, id } = target.parse(request.params);
    const user = await deps.userOf(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => {
      await checkTarget(env, model, id, false);
      const found = await env
        .sudo(`attachment list of ${model}`)
        .model(ATTACHMENT)
        .search([
          ['resModel', '=', model],
          ['resId', '=', id],
        ]);
      return {
        attachments: (await found.read(['id', ...PUBLIC_FIELDS])) as unknown as AttachmentRow[],
      };
    });
  });

  app.get<{ Params: { id: string } }>('/attachments/:id/content', async (request, reply) => {
    const tenant = deps.tenantOf(request);
    available(tenant);
    const { id } = attachmentId.parse(request.params);
    const user = await deps.userOf(request);
    const file = await deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => {
      const found = await env
        .sudo(`attachment download ${id}`)
        .model(ATTACHMENT)
        .search([['id', '=', id]]);
      const [row] = await found.read([
        'name',
        'resModel',
        'resId',
        'mimetype',
        'scanStatus',
        'storeKey',
      ]);
      if (!row) throw new HttpError(404, 'not_found', 'Unknown attachment.');
      await checkTarget(env, String(row.resModel), String(row.resId), false);
      if (row.scanStatus !== 'clean') {
        throw new HttpError(
          409,
          row.scanStatus === 'infected' ? 'infected' : 'not_scanned',
          row.scanStatus === 'infected'
            ? 'The antivirus found a threat in this file: it cannot be downloaded.'
            : 'This file has not been checked by the antivirus yet.',
        );
      }
      return {
        name: String(row.name),
        mimetype: typeof row.mimetype === 'string' ? row.mimetype : 'application/octet-stream',
        data: await options.s3.get(String(row.storeKey)),
      };
    });
    void reply
      .header(
        'content-type',
        SAFE_TYPES.has(file.mimetype) ? file.mimetype : 'application/octet-stream',
      )
      .header('content-disposition', contentDisposition(file.name))
      .header('x-content-type-options', 'nosniff');
    return reply.send(Buffer.from(file.data));
  });
}
